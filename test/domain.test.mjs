import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('同一提示资源可被不同终态使用，失败页面不等于没有下载过提示', async () => {
  const source = await startSource();
  try {
    const client = new SourceClient(source.base);
    const first = decode((await client.request('/exchange/page-1')).bytes);
    const second = decode((await client.request('/exchange/page-2')).bytes);
    const failed = decode((await client.request('/exchange/cancelled')).bytes);
    assert.deepEqual(first.hints, second.hints);
    assert.notEqual(first.body, second.body);
    assert.equal(failed.finalStatus, 503);
    assert.equal(failed.hints.length, 1);
    assert.ok((await client.request('/assets/logo')).bytes.length);
  } finally { await source.close(); }
});
