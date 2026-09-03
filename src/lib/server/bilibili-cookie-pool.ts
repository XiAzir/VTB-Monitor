import { getSecret, listSecretMetadata, updateSecretStatus } from './store';

const PREFIX = 'bilibili_cookie_pool:';
let cursor = 0;
const cooldowns = new Map<string, number>();

/** Selects an encrypted pool entry using process-local round robin.
 * Legacy single-cookie deployments remain supported as a fallback. */
export function getBilibiliCookie(): string | null {
  const keys = listSecretMetadata()
    .filter((row) => String(row.key).startsWith(PREFIX) && row.status !== 'invalid'
      && (cooldowns.get(String(row.key)) ?? 0) <= Date.now())
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((row) => String(row.key));
  if (keys.length > 0) {
    const key = keys[cursor % keys.length];
    cursor = (cursor + 1) % keys.length;
    return getSecret(key);
  }
  return getSecret('bilibili_cookie');
}

/** Marks the pool entry which produced an API error without exposing its value. */
export function markBilibiliCookieFailure(cookie: string | null, error: unknown): void {
  if (!cookie) return;
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number((error as { code?: unknown }).code) : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const isInvalid = code === -101 || code === -352 || /(?:^|\D)(-101|-352)(?:\D|$)/.test(message);
  const isRateLimited = code === 412 || code === 429 || /(?:412|429)|rate.?limit/i.test(message);
  if (!isInvalid && !isRateLimited) return;
  for (const row of listSecretMetadata().filter((entry) => String(entry.key).startsWith(PREFIX))) {
    const key = String(row.key);
    if (getSecret(key) !== cookie) continue;
    if (isInvalid) updateSecretStatus(key, 'invalid');
    else cooldowns.set(key, Date.now() + 60 * 60_000);
    return;
  }
}

export function bilibiliCookiePoolKey(id: string): string {
  const normalized = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!normalized) throw new Error('Cookie 池条目 ID 不能为空');
  return `${PREFIX}${normalized}`;
}
