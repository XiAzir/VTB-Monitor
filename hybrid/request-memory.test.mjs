import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapRequestMemory, installRequestMemoryBoundary } from './request-memory.mjs';
test('preserves request identity and streaming response', async () => {
  let calls = 0; const init = { method: 'POST', body: 'x'.repeat(8) }; const input = 'http://localhost/test';
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('stream')); c.close(); } }));
  const wrapped = wrapRequestMemory((i, o) => { assert.equal(i, input); assert.equal(o, init); return Promise.resolve(response); }, () => calls++, 4);
  assert.equal(await wrapped(input, init), response); assert.equal(calls, 2); assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'stream');
});
test('small requests are unchanged and do not force GC', async () => {
  const response = new Response('ok'); const wrapped = wrapRequestMemory(() => Promise.resolve(response), () => assert.fail('unexpected GC'), 100);
  assert.equal(await wrapped('x', { body: 'small' }), response);
});
test('does not swallow or retry errors', async () => {
  const error = new Error('upstream'); let count = 0;
  const wrapped = wrapRequestMemory(() => { count++; return Promise.reject(error); }, () => {}, 1);
  await assert.rejects(wrapped('x', { body: 'large' }), e => e === error); assert.equal(count, 1);
});

test('request-boundary GC is opt-in and missing GC support is safe', () => {
  const previous = process.env.VTBM_REQUEST_GC;
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'gc');
  try {
    Object.defineProperty(globalThis, 'gc', { value: () => {}, writable: true, configurable: true });
    for (const value of [undefined, '0', 'false', '']) {
      if (value === undefined) delete process.env.VTBM_REQUEST_GC;
      else process.env.VTBM_REQUEST_GC = value;
      assert.equal(installRequestMemoryBoundary(), false);
      assert.equal(globalThis.fetch, originalFetch);
    }
    process.env.VTBM_REQUEST_GC = '1';
    assert.equal(installRequestMemoryBoundary(), true);
    assert.notEqual(globalThis.fetch, originalFetch);
    globalThis.fetch = originalFetch;
    globalThis.gc = undefined;
    assert.equal(installRequestMemoryBoundary(), false);
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'gc', descriptor);
    else delete globalThis.gc;
    if (previous === undefined) delete process.env.VTBM_REQUEST_GC;
    else process.env.VTBM_REQUEST_GC = previous;
  }
});
