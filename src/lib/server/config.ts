import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const mediaDir = resolve(dataDir, 'media');
const backupDir = resolve(dataDir, 'backups');

for (const directory of [dataDir, mediaDir, backupDir]) {
  mkdirSync(directory, { recursive: true });
}

export function getEncryptionKey(): Buffer {
  const configured = process.env.APP_ENCRYPTION_KEY;
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes encoded as base64');
    return decoded;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_ENCRYPTION_KEY is required in production');
  }
  return createHash('sha256').update('vtb-monitor-development-only-key').digest();
}

export const config = {
  dataDir,
  mediaDir,
  backupDir,
  databasePath: resolve(dataDir, 'vtb-monitor.sqlite'),
  piDatabasePath: resolve(dataDir, 'pi-sessions.sqlite'),
  mediaQuotaBytes: Number(process.env.MEDIA_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024),
  maxMediaFileBytes: Number(process.env.MAX_MEDIA_FILE_BYTES ?? 25 * 1024 * 1024),
  timezone: process.env.TZ ?? 'Asia/Shanghai',
  webHost: process.env.HOST ?? '127.0.0.1',
  webPort: Number(process.env.PORT ?? 4311),
  managementHost: process.env.MANAGEMENT_HOST ?? '127.0.0.1',
  managementPort: Number(process.env.MANAGEMENT_PORT ?? 4312),
  origin: process.env.ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 4311}`,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  livePollSeconds: 30,
  dynamicPollSeconds: 300,
  commentPageDelayMs: 1500,
  processId: `${process.pid}-${randomBytes(4).toString('hex')}`
} as const;
