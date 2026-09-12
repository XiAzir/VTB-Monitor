/** Explicit collection at LARGE outgoing-request boundaries, not every HTTP call.
 * The SDK still owns request construction, auth, retries and streaming decoding.
 * No response is buffered here, and request/response objects are never modified.
 */
export function wrapRequestMemory(fetchFn, collect, threshold = 1024 * 1024) {
  return function fetchWithMemoryBoundary(input, init) {
    const size = typeof init?.body === 'string' ? init.body.length
      : ArrayBuffer.isView(init?.body) ? init.body.byteLength : 0;
    if (size < threshold) return fetchFn(input, init);
    collect();
    return fetchFn(input, init).then(response => { collect(); return response; });
  };
}
export function installRequestMemoryBoundary() {
  if (process.env.VTBM_REQUEST_GC === '0' || typeof globalThis.gc !== 'function') return;
  globalThis.fetch = wrapRequestMemory(globalThis.fetch.bind(globalThis), () => globalThis.gc());
}
