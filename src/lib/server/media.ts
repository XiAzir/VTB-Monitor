import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import { config } from './config';
import { getDb } from './db';
import { upsertAlert } from './store';

type Row = Record<string, unknown>;

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export async function downloadMediaAsset(mediaId: string): Promise<void> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media_assets WHERE id=?').get(mediaId) as Row | undefined;
  if (!row || row.state === 'stored') return;
  const used = Number((db.prepare("SELECT COALESCE(SUM(byte_size),0) AS total FROM media_assets WHERE state='stored'").get() as Row).total);
  if (used >= config.mediaQuotaBytes) {
    db.prepare("UPDATE media_assets SET state='quota_exceeded',error=?,updated_at=? WHERE id=?")
      .run('媒体配额已满', new Date().toISOString(), mediaId);
    upsertAlert('media-quota-full', 'critical', '媒体配额已满', '媒体目录已达到 5GB 上限，新图片下载已暂停。');
    return;
  }
  if (used >= config.mediaQuotaBytes * 0.9) {
    upsertAlert('media-quota-warning', 'warning', '媒体空间即将用完', '媒体目录使用量已超过配额的 90%。');
  }

  const sourceUrl = String(row.source_url);
  const tempDir = resolve(config.mediaDir, '.tmp');
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${randomUUID()}.part`);
  try {
    const requestUrl = /^http:\/\/i0\.hdslb\.com\//i.test(sourceUrl) ? sourceUrl.replace(/^http:/i, 'https:') : sourceUrl;
    const response = await fetch(requestUrl, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/', accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok || !response.body) throw new Error(`图片下载 HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > config.maxMediaFileBytes) throw new Error('图片超过单文件 25MB 限制');

    let bytes = 0;
    const hasher = createHash('sha256');
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    source.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > config.maxMediaFileBytes) source.destroy(new Error('图片超过单文件 25MB 限制'));
      hasher.update(chunk);
    });
    await pipeline(source, createWriteStream(tempPath, { flags: 'wx' }));
    if (used + bytes > config.mediaQuotaBytes) throw new Error('媒体配额不足');
    const detected = await fileTypeFromFile(tempPath);
    if (!detected || !ALLOWED_MIME.has(detected.mime)) throw new Error('下载内容不是支持的图片格式');
    const sha256 = hasher.digest('hex');
    const relative = join(sha256.slice(0, 2), `${sha256}.${detected.ext}`);
    const finalPath = resolve(config.mediaDir, relative);
    await mkdir(dirname(finalPath), { recursive: true });
    const existing = db.prepare("SELECT id,local_path FROM media_assets WHERE sha256=? AND state='stored'").get(sha256) as Row | undefined;
    if (existing?.local_path) {
      await rm(tempPath, { force: true });
      const existingId = String(existing.id);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [table, owner] of [['dynamic_media', 'dynamic_id'], ['comment_media', 'comment_id']] as const) {
          db.prepare(`INSERT OR IGNORE INTO ${table}(${owner},media_id,position) SELECT ${owner},?,position FROM ${table} WHERE media_id=?`)
            .run(existingId, mediaId);
          db.prepare(`DELETE FROM ${table} WHERE media_id=?`).run(mediaId);
        }
        db.prepare('DELETE FROM media_assets WHERE id=?').run(mediaId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    await rename(tempPath, finalPath);
    db.prepare(`UPDATE media_assets SET sha256=?,local_path=?,mime_type=?,byte_size=?,state='stored',error=NULL,updated_at=? WHERE id=?`)
      .run(sha256, relative, detected.mime, bytes, new Date().toISOString(), mediaId);
  } catch (error) {
    await rm(tempPath, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    const state = /配额/.test(message) ? 'quota_exceeded' : 'failed';
    db.prepare('UPDATE media_assets SET state=?,error=?,updated_at=? WHERE id=?')
      .run(state, message.slice(0, 1000), new Date().toISOString(), mediaId);
    throw error;
  }
}

export async function resolveMediaFile(mediaId: string): Promise<{ stream: ReturnType<typeof createReadStream>; mime: string; size: number } | null> {
  const row = getDb().prepare("SELECT local_path,mime_type FROM media_assets WHERE id=? AND state='stored'").get(mediaId) as Row | undefined;
  if (!row?.local_path) return null;
  const root = resolve(config.mediaDir);
  const path = resolve(root, String(row.local_path));
  if (!path.startsWith(root + '\\') && !path.startsWith(root + '/')) return null;
  const info = await stat(path);
  return { stream: createReadStream(path), mime: String(row.mime_type ?? mimeFromExtension(path)), size: info.size };
}

function mimeFromExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : 'image/jpeg';
}
