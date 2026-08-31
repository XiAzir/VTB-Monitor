import { readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { config } from './config';
import { getDb } from './db';

type Row = Record<string, any>;

/** Reclaims data that is not part of the dynamic/revision history. */
export async function cleanupStorage(): Promise<{ messages: number; jobs: number; logs: number; media: number }> {
  const db = getDb();
  const now = Date.now();
  let messages = 0;
  // The runtime only loads the latest four messages. Keep those and a compact marker.
  const conversations = db.prepare('SELECT id FROM pi_conversations').all() as Row[];
  for (const conversation of conversations) {
    const rows = db.prepare('SELECT id,role,content_json,created_at FROM pi_messages WHERE conversation_id=? ORDER BY created_at DESC').all(String(conversation.id)) as Row[];
    if (rows.length <= 8) continue;
    const remove = rows.slice(4);
    const roles = remove.map((row) => { try { return String(JSON.parse(String(row.content_json ?? '{}')).role ?? 'unknown'); } catch { return 'unknown'; } });
    const hasSummary = rows.some((row) => String(row.role) === 'system' && String(row.content_json ?? '').includes('history_summary'));
    if (!hasSummary) {
      const summary = JSON.stringify({ type: 'history_summary', messageCount: remove.length, roles: [...new Set(roles)] });
      db.prepare(`INSERT INTO pi_messages(id,conversation_id,role,content_json,created_at) VALUES (?,?,?,?,?)`)
        .run(randomUUID(), String(conversation.id), 'system', summary, new Date().toISOString());
    }
    db.prepare(`DELETE FROM pi_messages WHERE id IN (${remove.map(() => '?').join(',')})`).run(...remove.map((row) => String(row.id)));
    messages += remove.length;
  }
  const cut30 = new Date(now - 30 * 86400_000).toISOString();
  const cut90 = new Date(now - 90 * 86400_000).toISOString();
  const jobs = Number(db.prepare("DELETE FROM jobs WHERE status IN ('done','failed') AND updated_at<?").run(cut30).changes);
  const logs = Number(db.prepare('DELETE FROM audit_log WHERE created_at<?').run(cut90).changes);
  db.prepare('DELETE FROM ai_usage WHERE created_at<?').run(cut90);
  db.prepare("DELETE FROM pi_tool_runs WHERE created_at<?").run(cut90);
  messages += 0;

  // Remove failed temporary downloads and unreferenced stored media. Revision snapshots
  // are JSON, so retain an asset if any historical snapshot mentions its source URL.
  const snapshots = (db.prepare('SELECT snapshot_json FROM dynamic_revisions').all() as Row[])
    .map((row) => String(row.snapshot_json ?? '')).join('\n');
  const assets = db.prepare(`SELECT id,source_url,local_path,state FROM media_assets`).all() as Row[];
  let media = 0;
  for (const asset of assets) {
    const id = String(asset.id);
    const referenced = db.prepare(`SELECT 1 FROM dynamic_media WHERE media_id=? UNION ALL SELECT 1 FROM comment_media WHERE media_id=? UNION ALL SELECT 1 FROM media_source_aliases WHERE media_id=? LIMIT 1`).get(id, id, id);
    const historical = snapshots.includes(String(asset.source_url));
    if (referenced || historical) continue;
    if (asset.local_path) await rm(resolve(config.mediaDir, String(asset.local_path)), { force: true });
    db.prepare('DELETE FROM media_source_aliases WHERE media_id=?').run(id);
    db.prepare('DELETE FROM media_assets WHERE id=?').run(id);
    media += 1;
  }
  const tmp = join(config.mediaDir, '.tmp');
  for (const file of await readdir(tmp, { withFileTypes: true }).catch(() => [])) {
    if (file.isFile()) await rm(join(tmp, file.name), { force: true });
  }
  db.exec('PRAGMA optimize');
  db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
  return { messages, jobs, logs, media };
}
