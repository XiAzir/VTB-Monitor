import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
  acknowledgeAlert, authenticateApiToken, createStreamer, enqueueJob, getDashboardStats, getSecret,
  listAdminStreamers, listAlerts, listAudit, listDynamicRevisions, listDynamics, listJobs, listSecretMetadata, putSecret,
  queuePiManualAnalysis, updateStreamer
} from '$lib/server/store';

type Token = NonNullable<ReturnType<typeof authenticateApiToken>>;

export const GET: RequestHandler = async (event) => dispatch(event, 'GET');
export const POST: RequestHandler = async (event) => dispatch(event, 'POST');
export const PATCH: RequestHandler = async (event) => dispatch(event, 'PATCH');

async function dispatch(event: Parameters<RequestHandler>[0], method: string): Promise<Response> {
  if (event.request.headers.get('x-vtbm-management-listener') !== 'internal-v1' || !isLoopbackAddress(event.getClientAddress())) error(404, 'Not found');
  const path = `/${event.params.path ?? ''}`.replace(/\/+$/, '') || '/';
  if (path === '/healthz' && method === 'GET') return json({ status: 'ok', time: new Date().toISOString() });
  if (path === '/openapi.json' && method === 'GET') return json(openApiDocument());
  const token = requireToken(event.request);

  if (method === 'GET' && path === '/status') { requireScope(token, 'status:read'); return json({ data: getDashboardStats(), time: new Date().toISOString() }); }
  if (method === 'GET' && path === '/streamers') { requireScope(token, 'config:read'); return json({ data: listAdminStreamers() }); }
  const streamerDynamics = path.match(/^\/streamers\/([^/]+)\/dynamics$/);
  if (method === 'GET' && streamerDynamics) { requireScope(token, 'config:read'); return json({ data: listDynamics(streamerDynamics[1], 50) }); }
  const dynamicRevisions = path.match(/^\/dynamics\/([^/]+)\/revisions$/);
  if (method === 'GET' && dynamicRevisions) { requireScope(token, 'config:read'); return json({ data: listDynamicRevisions(dynamicRevisions[1]) }); }
  if (method === 'GET' && path === '/jobs') { requireScope(token, 'status:read'); return json({ data: listJobs(100) }); }
  if (method === 'GET' && path === '/alerts') { requireScope(token, 'status:read'); return json({ data: listAlerts() }); }
  if (method === 'GET' && path === '/audit') { requireScope(token, 'audit:read'); return json({ data: listAudit(200) }); }
  if (method === 'GET' && path === '/secrets') { requireScope(token, 'secrets:read'); return json({ data: listSecretMetadata() }, noStore()); }
  const secretReveal = path.match(/^\/secrets\/([^/]+)\/reveal$/);
  if (method === 'GET' && secretReveal) {
    requireScope(token, 'secrets:read');
    const value = getSecret(decodeURIComponent(secretReveal[1]), `api-token:${token.id}`);
    if (value == null) error(404, 'Secret not found');
    return json({ key: decodeURIComponent(secretReveal[1]), value }, noStore());
  }

  if (method === 'POST' && path === '/streamers') {
    requireScope(token, 'config:write');
    return idempotent(event.request, token, path, async () => {
      const body = await parseJsonBody(event.request) as Parameters<typeof createStreamer>[0];
      const id = createStreamer(body, `api-token:${token.id}`);
      return { status: 201, body: { id } };
    });
  }
  const streamerPatch = path.match(/^\/streamers\/([^/]+)$/);
  if (method === 'PATCH' && streamerPatch) {
    requireScope(token, 'config:write');
    return idempotent(event.request, token, path, async () => {
      const body = await parseJsonBody(event.request) as Record<string, unknown>;
      const version = Number(body.version);
      const { version: _, ...changes } = body;
      updateStreamer(streamerPatch[1], changes, version, `api-token:${token.id}`);
      return { status: 200, body: { updated: true } };
    });
  }
  const operation = path.match(/^\/streamers\/([^/]+)\/operations\/(sync|refresh|reanalyze|reforecast)$/);
  if (method === 'POST' && operation) {
    requireScope(token, 'ops:run');
    return idempotent(event.request, token, path, async () => {
      const jobId = operation[2] === 'sync' || operation[2] === 'refresh'
        ? enqueueJob('sync_streamer', operation[1], operation[2] === 'refresh' ? { fullSync: true } : {}, 5,
          new Date().toISOString(), `api:${event.request.headers.get('idempotency-key')}`)
        : queuePiManualAnalysis(operation[1], operation[2]);
      return { status: 202, body: { jobId } };
    });
  }
  const dynamicRefresh = path.match(/^\/dynamics\/([^/]+)\/operations\/refresh$/);
  if (method === 'POST' && dynamicRefresh) {
    requireScope(token, 'ops:run');
    return idempotent(event.request, token, path, async () => {
      const jobId = enqueueJob('refresh_dynamic', dynamicRefresh[1], {}, 5, new Date().toISOString(),
        `api:${event.request.headers.get('idempotency-key')}`);
      return { status: 202, body: { jobId } };
    });
  }
  const secretWrite = path.match(/^\/secrets\/([^/]+)$/);
  if (method === 'POST' && secretWrite) {
    requireScope(token, 'secrets:write');
    return idempotent(event.request, token, path, async () => {
      const body = await parseJsonBody(event.request) as { value?: string };
      if (!body.value) error(400, 'value is required');
      putSecret(decodeURIComponent(secretWrite[1]), body.value, `api-token:${token.id}`);
      return { status: 200, body: { updated: true } };
    });
  }
  const alertAck = path.match(/^\/alerts\/([^/]+)\/acknowledge$/);
  if (method === 'POST' && alertAck) {
    requireScope(token, 'ops:run');
    acknowledgeAlert(alertAck[1], `api-token:${token.id}`);
    return json({ acknowledged: true });
  }
  error(404, 'Unknown management endpoint');
}

function requireToken(request: Request): Token {
  const authorization = request.headers.get('authorization');
  const value = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!value) error(401, 'Bearer token required');
  const token = authenticateApiToken(value);
  if (!token) error(401, 'Invalid or expired token');
  return token;
}

function requireScope(token: Token, scope: string): void {
  if (!token.scopes.includes(scope)) error(403, `Missing scope: ${scope}`);
}

const MAX_REQUEST_BYTES = 1024 * 1024;

function parseJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_REQUEST_BYTES) error(413, 'Request body is too large');
  return request.text().then((text) => {
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) error(413, 'Request body is too large');
    try { return JSON.parse(text); } catch { error(400, 'Invalid JSON'); }
  });
}

async function idempotent(request: Request, token: Token, path: string,
  work: () => Promise<{ status: number; body: unknown }>): Promise<Response> {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 200) error(400, 'Idempotency-Key is required');
  const storedKey = `${token.id}:${key}`;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(now);
  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key=?').get(storedKey) as Record<string, unknown> | undefined;
  if (existing) {
    if (existing.method !== request.method || existing.path !== path) error(409, 'Idempotency-Key was already used for another operation');
    if (Number(existing.response_status) === 0) error(409, 'The same operation is already in progress');
    return json(JSON.parse(String(existing.response_json)), { status: Number(existing.response_status) });
  }
  try {
    db.prepare(`INSERT INTO idempotency_keys(key,actor_id,method,path,response_status,response_json,expires_at,created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(storedKey, token.id, request.method, path, JSON.stringify({ processing: true }),
        new Date(Date.now() + 24 * 3600_000).toISOString(), now);
  } catch (reason) {
    const raced = db.prepare('SELECT * FROM idempotency_keys WHERE key=?').get(storedKey) as Record<string, unknown> | undefined;
    if (raced && raced.method === request.method && raced.path === path) error(409, 'The same operation is already in progress');
    throw reason;
  }
  try {
    const result = await work();
    db.prepare('UPDATE idempotency_keys SET response_status=?,response_json=? WHERE key=?')
      .run(result.status, JSON.stringify(result.body), storedKey);
    return json(result.body, { status: result.status });
  } catch (reason) {
    db.prepare('DELETE FROM idempotency_keys WHERE key=? AND response_status=0').run(storedKey);
    throw reason;
  }
}
function noStore() { return { headers: { 'cache-control': 'no-store, private', pragma: 'no-cache' } }; }

function openApiDocument() {
  return {
    openapi: '3.1.0', info: { title: 'VTB Monitor Local Management API', version: '1.0.0' },
    servers: [{ url: 'http://127.0.0.1:4312/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }],
    paths: {
      '/healthz': { get: { security: [], summary: 'Health check' } },
      '/status': { get: { summary: 'Runtime summary', 'x-scope': 'status:read' } },
      '/streamers': { get: { summary: 'List streamers', 'x-scope': 'config:read' }, post: { summary: 'Create streamer', 'x-scope': 'config:write' } },
      '/streamers/{id}': { patch: { summary: 'Update streamer with version field', 'x-scope': 'config:write' } },
      '/streamers/{id}/dynamics': { get: { summary: 'List archived dynamics', 'x-scope': 'config:read' } },
      '/streamers/{id}/operations/{operation}': { post: { summary: 'Run sync, six-month refresh, reanalyze, or reforecast', 'x-scope': 'ops:run' } },
      '/dynamics/{id}/revisions': { get: { summary: 'List archived dynamic revisions', 'x-scope': 'config:read' } },
      '/dynamics/{id}/operations/refresh': { post: { summary: 'Refresh one dynamic and detect deletion', 'x-scope': 'ops:run' } },
      '/jobs': { get: { summary: 'List jobs', 'x-scope': 'status:read' } }, '/alerts': { get: { summary: 'List alerts', 'x-scope': 'status:read' } },
      '/audit': { get: { summary: 'Read audit log', 'x-scope': 'audit:read' } },
      '/secrets': { get: { summary: 'List secret metadata', 'x-scope': 'secrets:read' } },
      '/secrets/{key}': { post: { summary: 'Write secret', 'x-scope': 'secrets:write' } },
      '/secrets/{key}/reveal': { get: { summary: 'Reveal secret value', 'x-scope': 'secrets:read' } }
    }
  };
}

function isLoopbackAddress(address: string): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
