import { createHash, randomUUID } from 'node:crypto';
import { decode } from './decode.mjs';

export class Cancelled extends Error {
  constructor() { super('采集已取消'); this.name = 'CancelledError'; }
}

// 同一地址只有在请求条件一致时才允许复用暂定领取。
function conditionsKey(url, headers) {
  const normalized = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([url, normalized])).digest('hex');
}

export function* parseLinks(value) {
  for (const part of String(value).split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>\s*((?:;[^,]*)?)$/.exec(part.trim());
    if (!match) continue;
    const params = {};
    for (const piece of match[2].split(';')) {
      const eq = piece.indexOf('=');
      if (eq < 0) continue;
      params[piece.slice(0, eq).trim().toLowerCase()] = piece.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    }
    yield { target: match[1], params };
  }
}

export function extractImages(html, pageUrl) {
  const found = [];
  const seen = new Set();
  for (const match of String(html).matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    let url;
    try { url = new URL(match[1], pageUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    found.push(url.href);
  }
  return found;
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

// 暂定领取库：提示触发的领取只是暂定工作，按引用计数共享；
// 最后一个使用方放弃且未曾正式采用时才中止并丢弃，取消任何一个页面都不会删掉其他页面仍在用的字节。
export class TentativeStore {
  constructor() { this.entries = new Map(); }

  acquire(key, start) {
    const existing = this.entries.get(key);
    if (existing) { existing.refs += 1; return { entry: existing, shared: true }; }
    const controller = new AbortController();
    const entry = { refs: 1, adopted: false, controller, state: 'fetching', value: null, error: null };
    try {
      entry.promise = Promise.resolve(start(controller.signal)).then(
        value => { entry.state = 'ready'; entry.value = value; return value; },
        error => { entry.state = 'failed'; entry.error = error; throw error; });
    } catch (error) {
      entry.state = 'failed';
      entry.error = error;
      entry.promise = Promise.reject(error);
    }
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    return { entry, shared: false };
  }

  markAdopted(key) {
    const entry = this.entries.get(key);
    if (entry) entry.adopted = true;
  }

  release(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (!entry.adopted) entry.controller.abort();
    this.entries.delete(key);
  }
}

export class Collector {
  constructor({ client, catalog, maxHops = 5 } = {}) {
    if (!client || !catalog) throw new TypeError('采集需要来源客户端与目录');
    this.client = client;
    this.catalog = catalog;
    this.store = new TentativeStore();
    this.maxHops = maxHops;
  }

  async collect(path, { headers = {}, signal } = {}) {
    const record = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      request: { path, conditions: { ...headers } },
      outcome: 'incomplete',
      chain: [],
      finalUrl: null,
      page: null,
      resources: [],
      tentative: [],
      incomplete: [],
      stats: { pageRequests: 0, resourceRequests: 0, shared: 0, savedRequests: 0 },
      failure: null
    };
    const session = { holds: new Map(), signal };
    try {
      await this.walk(record, session, path, headers);
    } catch (error) {
      if (signal?.aborted || error instanceof Cancelled) {
        record.outcome = 'cancelled';
        record.failure = '采集已取消';
      } else {
        record.outcome = 'incomplete';
        record.failure = error.message;
      }
    } finally {
      for (const [key, hold] of session.holds) {
        if (!hold.adopted) this.discard(record, hold.url, record.failure || '采集结束未采用');
        this.store.release(key);
      }
      session.holds.clear();
      record.finishedAt = new Date().toISOString();
      await this.catalog.saveCollection(record);
    }
    return record;
  }

  async walk(record, session, path, headers) {
    let current = path;
    for (let hop = 0; hop < this.maxHops; hop++) {
      if (session.signal?.aborted) throw new Cancelled();
      const result = await this.client.request(current, { headers, signal: session.signal });
      record.stats.pageRequests += 1;
      const view = this.pageView(result);
      // 事件按实际发生顺序处理：先按提示暂定领取，再看终态决定采用或作废。
      const hopHolds = this.startHints(record, session, result.url, view.hints, headers);
      const receipt = await this.catalog.accept({
        source: result.url, bytes: result.bytes,
        mediaType: result.headers['content-type'] || null, preview: view.preview });
      record.chain.push({ url: result.url, status: view.finalStatus, digest: receipt.digest, receiptId: receipt.id });

      const location = view.finalHeaders?.location;
      if (view.finalStatus >= 300 && view.finalStatus < 400 && location) {
        this.releaseHop(record, session, hopHolds, '页面跳转，提示未采用');
        current = new URL(location, result.url).href;
        continue;
      }
      if (view.finalStatus < 200 || view.finalStatus >= 400) {
        this.releaseHop(record, session, hopHolds, `页面终态 ${view.finalStatus}，提示未采用`);
        record.page = { digest: receipt.digest, receiptId: receipt.id, finalStatus: view.finalStatus };
        record.failure = `页面终态 ${view.finalStatus}`;
        record.outcome = 'incomplete';
        return;
      }
      record.finalUrl = result.url;
      record.page = { digest: receipt.digest, receiptId: receipt.id, finalStatus: view.finalStatus };
      for (const url of extractImages(view.bodyText, result.url)) {
        await this.adopt(record, session, url, headers);
      }
      for (const hold of hopHolds) {
        if (!hold.adopted) this.discard(record, hold.url, '页面未采用');
      }
      record.outcome = record.incomplete.length > 0 ? 'incomplete' : 'collected';
      return;
    }
    throw new Error('跳转次数超过本地上限');
  }

  pageView(result) {
    const type = result.headers['content-type'] || '';
    if (type.includes('application/json')) {
      const preview = decode(result.bytes);
      return { preview, hints: preview.hints, finalStatus: preview.finalStatus,
        finalHeaders: preview.finalHeaders || {}, bodyText: preview.body || '' };
    }
    return { preview: null, hints: [], finalStatus: result.status,
      finalHeaders: result.headers, bodyText: result.bytes.toString('utf8') };
  }

  startHints(record, session, pageUrl, hints, headers) {
    const holds = [];
    for (const header of hints || []) {
      for (const link of parseLinks(header?.link ?? '')) {
        const as = link.params.as || null;
        if ((link.params.rel || '').toLowerCase() !== 'preload') continue;
        let url;
        try { url = new URL(link.target, pageUrl).href; } catch {
          record.tentative.push({ url: link.target, as, disposition: 'skipped', reason: '提示地址无法解析' });
          continue;
        }
        if (as && as.toLowerCase() !== 'image') {
          record.tentative.push({ url, as, disposition: 'skipped', reason: '非配图提示' });
          continue;
        }
        const key = conditionsKey(url, headers);
        if (session.holds.has(key)) continue;
        const { entry, shared } = this.store.acquire(key,
          abortSignal => this.fetchResource(record, url, headers, abortSignal));
        const hold = { key, url, entry, shared, adopted: false };
        session.holds.set(key, hold);
        holds.push(hold);
        if (shared) record.stats.shared += 1;
        record.tentative.push({ url, as, disposition: 'pending', reason: null });
      }
    }
    return holds;
  }

  async fetchResource(record, url, headers, signal) {
    record.stats.resourceRequests += 1;
    const result = await this.client.request(url, { headers, signal });
    if (result.status !== 200) throw new Error(`来源返回 ${result.status}`);
    return result;
  }

  async adopt(record, session, url, headers) {
    const key = conditionsKey(url, headers);
    let hold = session.holds.get(key);
    let via = 'hint';
    if (!hold) {
      via = 'final';
      const acquired = this.store.acquire(key, signal => this.fetchResource(record, url, headers, signal));
      hold = { key, url, entry: acquired.entry, shared: acquired.shared, adopted: false };
      session.holds.set(key, hold);
      if (hold.shared) record.stats.shared += 1;
    }
    let result = null;
    let postFinalRequest = via === 'final' && !hold.shared;
    try {
      result = await waitFor(hold.entry.promise, session.signal);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      postFinalRequest = true;
      try {
        record.stats.resourceRequests += 1;
        const retry = await this.client.request(url, { headers, signal: session.signal });
        if (retry.status !== 200) throw new Error(`来源返回 ${retry.status}`);
        result = retry;
      } catch (retryError) {
        if (session.signal?.aborted) throw new Cancelled();
        this.fail(record, hold, retryError.message);
        return;
      }
    }
    const receipt = await this.catalog.accept({
      source: url, bytes: result.bytes,
      mediaType: result.headers['content-type'] || null, preview: null });
    hold.adopted = true;
    this.store.markAdopted(key);
    record.resources.push({ url, digest: receipt.digest, receiptId: receipt.id, via, savedRequest: !postFinalRequest });
    if (!postFinalRequest) record.stats.savedRequests += 1;
    const hinted = record.tentative.find(item => item.url === url && item.disposition === 'pending');
    if (hinted) hinted.disposition = 'adopted';
  }

  fail(record, hold, reason) {
    record.incomplete.push({ url: hold.url, reason });
    const hinted = record.tentative.find(item => item.url === hold.url && item.disposition === 'pending');
    if (hinted) { hinted.disposition = 'failed'; hinted.reason = reason; }
  }

  discard(record, url, reason) {
    for (const item of record.tentative) {
      if (item.url === url && item.disposition === 'pending') {
        item.disposition = 'discarded';
        item.reason = reason;
      }
    }
  }

  releaseHop(record, session, holds, reason) {
    for (const hold of holds) {
      this.discard(record, hold.url, reason);
      session.holds.delete(hold.key);
      this.store.release(hold.key);
    }
  }
}
