import { getSecret, listSecretMetadata } from './store';

const PREFIX = 'bilibili_cookie_pool:';
let cursor = 0;

/** Selects an encrypted pool entry using process-local round robin.
 * Legacy single-cookie deployments remain supported as a fallback. */
export function getBilibiliCookie(): string | null {
  const keys = listSecretMetadata()
    .filter((row) => String(row.key).startsWith(PREFIX) && row.status !== 'invalid')
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((row) => String(row.key));
  if (keys.length > 0) {
    const key = keys[cursor % keys.length];
    cursor = (cursor + 1) % keys.length;
    return getSecret(key);
  }
  return getSecret('bilibili_cookie');
}

export function bilibiliCookiePoolKey(id: string): string {
  const normalized = id.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!normalized) throw new Error('Cookie 池条目 ID 不能为空');
  return `${PREFIX}${normalized}`;
}

