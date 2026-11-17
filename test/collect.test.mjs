import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Catalog } from '../src/catalog.mjs';
import { Collector, TentativeStore, parseLinks, extractImages } from '../src/collect.mjs';
import { SourceClient } from '../src/transport.mjs';
import { profile } from '../src/profile.mjs';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

async function setup(scenario = 'ordinary') {
  const directory = await mkdtemp(join(tmpdir(), 'collect-test-'));
  const source = await startSource({ scenario });
  const catalog = await new Catalog(directory).initialize();
  const client = new SourceClient(source.base);
  const collector = new Collector({ client, catalog });
  return { directory, source, catalog, client, collector,
    close: async () => { await source.close(); await rm(directory, { recursive: true, force: true }); } };
}

const pathname = url => new URL(url).pathname;

test('提示被终页采用时建立正式关系，节省的请求如实计数', async () => {
  const { catalog, client, collector, close } = await setup();
  try {
    const record = await collector.collect('/exchange/page-2');
    assert.equal(record.outcome, 'collected');
    assert.deepEqual(Object.keys(record).sort(), [...profile.collectionKeys].sort());
    assert.equal(record.page.finalStatus, 200);
    assert.deepEqual(record.resources.map(item => pathname(item.url)), ['/assets/logo']);
    assert.equal(record.resources[0].via, 'hint');
    assert.equal(record.resources[0].savedRequest, true);
    assert.equal(record.stats.savedRequests, 1);
    assert.equal(record.stats.resourceRequests, 1);
    assert.equal(record.tentative[0].disposition, 'adopted');
    const logo = await client.request('/assets/logo');
    assert.deepEqual(await catalog.object(record.resources[0].digest), logo.bytes);
    assert.ok((await catalog.object(record.page.digest)).length > 0);
  } finally { await close(); }
});

test('提示未被终页采用时不进入正式资料', async () => {
  const { catalog, collector, close } = await setup();
  try {
    const record = await collector.collect('/exchange/page-1');
    assert.equal(record.outcome, 'collected');
    assert.deepEqual(record.resources.map(item => pathname(item.url)), ['/assets/photo-a']);
    assert.equal(record.resources[0].via, 'final');
    assert.equal(record.resources[0].savedRequest, false);
    assert.equal(record.stats.savedRequests, 0);
    assert.equal(record.tentative.length, 1);
    assert.equal(pathname(record.tentative[0].url), '/assets/logo');
    assert.equal(record.tentative[0].disposition, 'discarded');
    assert.match(record.tentative[0].reason, /未采用/);
    const sources = (await catalog.list()).map(receipt => receipt.source);
    assert.ok(sources.some(source => source.endsWith('/assets/photo-a')));
    assert.ok(!sources.some(source => source.endsWith('/assets/logo')));
  } finally { await close(); }
});

test('页面失败时提示只留暂定痕迹，未完成原因可查', async () => {
  const { catalog, collector, close } = await setup();
  try {
    const record = await collector.collect('/exchange/cancelled');
    assert.equal(record.outcome, 'incomplete');
    assert.equal(record.page.finalStatus, 503);
    assert.equal(record.resources.length, 0);
    assert.equal(record.tentative[0].disposition, 'discarded');
    assert.match(record.tentative[0].reason, /503/);
    assert.match(record.failure, /503/);
    const sources = (await catalog.list()).map(receipt => receipt.source);
    assert.ok(!sources.some(source => source.endsWith('/assets/logo')));
  } finally { await close(); }
});

test('跳转后以来源边界内的终页为准，越界跳转不越界领取', async () => {
  const { client, collector, close } = await setup('transition');
  try {
    await client.control({ action: 'advance' });
    const redirected = await collector.collect('/exchange/page-1');
    assert.equal(redirected.outcome, 'collected');
    assert.equal(redirected.chain.length, 2);
    assert.equal(redirected.chain[0].status, 302);
    assert.ok(redirected.finalUrl.endsWith('/pages/final'));
    assert.deepEqual(redirected.resources.map(item => pathname(item.url)), ['/assets/photo-b']);
    assert.equal(redirected.tentative[0].disposition, 'discarded');
    assert.match(redirected.tentative[0].reason, /跳转/);
    const outside = await collector.collect('/exchange/external');
    assert.equal(outside.outcome, 'incomplete');
    assert.match(outside.failure, /来源/);
    assert.equal(outside.chain.length, 1);
    assert.equal(outside.chain[0].status, 302);
    assert.equal(outside.resources.length, 0);
  } finally { await close(); }
});

test('并发页面共享同一份暂定字节，取消其一不影响另一个', async () => {
  const { catalog, client, collector, close } = await setup();
  try {
    const controller = new AbortController();
    const first = collector.collect('/exchange/slow', { signal: controller.signal });
    const second = collector.collect('/exchange/slow');
    await sleep(80);
    controller.abort();
    const [cancelled, kept] = await Promise.all([first, second]);
    assert.equal(cancelled.outcome, 'cancelled');
    assert.match(cancelled.failure, /取消/);
    assert.equal(kept.outcome, 'collected');
    assert.deepEqual(kept.resources.map(item => pathname(item.url)), ['/assets/photo-slow']);
    const audit = await client.control({ action: 'inspect' });
    assert.equal(audit.requests.filter(item => item.path === '/assets/photo-slow').length, 1);
    assert.ok((await catalog.object(kept.resources[0].digest)).length > 0);
    const stored = await catalog.collections();
    assert.equal(stored.length, 2);
    assert.ok(stored.some(item => item.outcome === 'cancelled'));
    assert.ok(stored.some(item => item.outcome === 'collected'));
  } finally { await close(); }
});

test('同一地址在请求条件不同时不复用暂定领取', async () => {
  const { client, collector, close } = await setup();
  try {
    const [first, second] = await Promise.all([
      collector.collect('/exchange/slow', { headers: { 'x-institution': 'inst-a' } }),
      collector.collect('/exchange/slow', { headers: { 'x-institution': 'inst-b' } })]);
    assert.equal(first.outcome, 'collected');
    assert.equal(second.outcome, 'collected');
    const audit = await client.control({ action: 'inspect' });
    const assets = audit.requests.filter(item => item.path === '/assets/photo-slow');
    assert.equal(assets.length, 2);
    assert.deepEqual(new Set(assets.map(item => item.headers['x-institution'])), new Set(['inst-a', 'inst-b']));
    const pages = audit.requests.filter(item => item.path === '/exchange/slow');
    assert.equal(pages.length, 2);
    assert.ok(pages.every(item => item.headers['x-institution']));
  } finally { await close(); }
});

test('资源缺失时记录未完成原因，不伪造正式关系', async () => {
  const { catalog, collector, close } = await setup();
  try {
    const record = await collector.collect('/exchange/broken');
    assert.equal(record.outcome, 'incomplete');
    assert.equal(record.resources.length, 0);
    assert.equal(record.incomplete.length, 1);
    assert.ok(record.incomplete[0].url.endsWith('/assets/missing'));
    assert.match(record.incomplete[0].reason, /404/);
    assert.equal(record.tentative[0].disposition, 'failed');
    const sources = (await catalog.list()).map(receipt => receipt.source);
    assert.ok(!sources.some(source => source.endsWith('/assets/missing')));
  } finally { await close(); }
});

test('暂定库按引用计数保留共享字节，正式采用后不再中止', async () => {
  const store = new TentativeStore();
  const signals = [];
  let started = 0;
  const start = signal => { started += 1; signals.push(signal); return new Promise(() => {}); };
  store.acquire('shared', start);
  const second = store.acquire('shared', start);
  assert.equal(started, 1);
  assert.ok(second.shared);
  store.release('shared');
  assert.equal(store.entries.size, 1);
  assert.equal(signals[0].aborted, false);
  store.release('shared');
  assert.equal(store.entries.size, 0);
  assert.equal(signals[0].aborted, true);
  store.acquire('kept', start);
  store.markAdopted('kept');
  store.release('kept');
  assert.equal(store.entries.size, 0);
  assert.equal(signals[1].aborted, false);
});

test('链接提示与页面配图解析', () => {
  const links = [...parseLinks('</assets/logo>; rel=preload; as=image')];
  assert.equal(links[0].target, '/assets/logo');
  assert.equal(links[0].params.rel, 'preload');
  assert.equal(links[0].params.as, 'image');
  assert.deepEqual(extractImages('<html><img src="/a.png"><img src="/a.png"><img src=\'/b.png\'></html>', 'http://127.0.0.1:9/pages/x'),
    ['http://127.0.0.1:9/a.png', 'http://127.0.0.1:9/b.png']);
});

test('查看服务提供采集接口，记录可回读并对上原件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collect-http-'));
  const source = await startSource();
  const app = await startApplication({ source: source.base, root: directory });
  try {
    const created = await fetch(`${app.base}/collections`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/exchange/page-2' }) });
    assert.equal(created.status, 201);
    const record = await created.json();
    assert.equal(record.outcome, 'collected');
    const listed = await fetch(`${app.base}/collections`).then(response => response.json());
    assert.ok(listed.some(item => item.id === record.id));
    const reread = await fetch(`${app.base}/collections/${record.id}`).then(response => response.json());
    assert.deepEqual(reread, record);
    const saved = await fetch(`${app.base}/objects/${record.resources[0].digest}`).then(response => response.arrayBuffer());
    const direct = await new SourceClient(source.base).request('/assets/logo');
    assert.deepEqual(Buffer.from(saved), direct.bytes);
  } finally {
    await app.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
