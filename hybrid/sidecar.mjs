/** Private, disposable host for the ORIGINAL SvelteKit handler and TypeScript Pi.
 * Only the Rust supervisor knows the ephemeral port and capability token.
 * It is not a second public web service. No scheduler is started here.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const token = process.env.VTBM_SIDECAR_TOKEN;
if (!token || token.length < 32 || process.env.VTBM_HYBRID_CHILD !== '1') {
  throw new Error('This entry point must be started by the Rust supervisor');
}
process.env.RUN_SCHEDULER = '0';
process.env.DISABLE_SCHEDULER = '1';
const key = Symbol.for('vtbm.hybrid.pi.v1');
let loadPromise;
let active = 0;
let lastActivity = Date.now();
let closing = false;
const idleMs = Number(process.env.VTBM_SIDECAR_IDLE_MS ?? 30000);
if (!Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 3600000) throw new Error('Invalid idle timeout');

function authorized(value) {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function load() {
  return loadPromise ??= import('../build/handler.js');
}
function reply(response, code, message) {
  if (response.destroyed) return;
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(message));
}
async function readJson(request) {
  let size = 0; const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error('Control request exceeds 64 KiB');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
const server = createServer({ maxHeaderSize: 16384, requestTimeout: 150000, headersTimeout: 15000 }, async (request, response) => {
  if (closing || !authorized(request.headers['x-vtbm-sidecar-token'])) {
    reply(response, 404, { error: 'Not found' }); return;
  }
  delete request.headers['x-vtbm-sidecar-token'];
  delete request.headers['x-vtbm-management-listener'];
  active += 1;
  let finished = false;
  const done = () => { if (!finished) { finished = true; active -= 1; lastActivity = Date.now(); } };
  response.once('finish', done); response.once('close', done);
  try {
    const path = request.url ?? '/';
    if (path === '/control/pi' && request.method === 'POST') {
      const body = await readJson(request);
      await load();
      const bridge = globalThis[key];
      if (!bridge) throw new Error('SvelteKit Pi bridge was not registered');
      // The bridge remains busy until the actual Pi promise settles, including cancellation.
      let completed = false;
      response.once('close', () => { if (!completed) process.exit(75); });
      try { await bridge.run(body); } finally { completed = true; }
      reply(response, 200, { ok: true });
      return;
    }
    const management = path.startsWith('/management/');
    if (!management && !path.startsWith('/web/')) { reply(response, 404, { error: 'Not found' }); return; }
    request.url = management ? `/agent-api${path.slice('/management'.length)}` : path.slice('/web'.length);
    if (management) request.headers['x-vtbm-management-listener'] = 'internal-v1';
    const { handler } = await load();
    handler(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Control errors go only to the authenticated supervisor; never expose stacks or keys.
    if (!response.headersSent) reply(response, 503, { error: message.slice(0, 1000) });
    else response.destroy();
  }
});
server.keepAliveTimeout = 2000;
server.maxRequestsPerSocket = 100;
server.maxConnections = 20;
server.listen(0, '127.0.0.1', () => {
  // stdout has exactly one bounded handshake. Subsequent application logging goes to stderr.
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: address.port, pid: process.pid }) + '\n');
  console.log = (...args) => console.error(...args);
});
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => {
    globalThis[key]?.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// A killed parent closes its pipe. Do not leave an orphaned Node host behind.
process.stdin.resume();
process.stdin.once('end', shutdown);
