import { randomUUID } from 'node:crypto';
import type { CommentRecord, DynamicRecord, ForecastRecord, LiveStatus, MediaAsset, StreamerSummary } from '$lib/types';
import { config } from './config';
import { getDb, withTransaction } from './db';
import { contentHash, createOpaqueToken, decryptSecret, encryptSecret, hashPassword, hashToken } from './security';

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const bool = (value: unknown) => Number(value) === 1;
const text = (value: unknown) => (value == null ? null : String(value));
const number = (value: unknown) => Number(value ?? 0);

export interface StreamerInput {
  slug: string;
  name: string;
  biliUid: string;
  roomId: string;
  dynamicUrl?: string;
  liveUrl?: string;
  avatarUrl?: string | null;
  timezone?: string;
  enabled?: boolean;
  livePollSeconds?: number;
  dynamicPollSeconds?: number;
}

export interface NormalizedDynamicInput {
  id: string;
  streamerId: string;
  type: string;
  text: string;
  sourceUrl: string;
  publishedAt: string;
  commentOid?: string | null;
  commentType?: string | null;
  commentCount?: number;
  likeCount?: number;
  mediaUrls?: string[];
  rawExcerpt?: string | null;
  emojiMap?: Record<string, string>;
  avatarUrl?: string | null;
}

export interface DynamicRevisionRecord {
  id: string;
  dynamicId: string;
  text: string;
  createdAt: string;
  snapshot: Row;
  media: MediaAsset[];
  emojiMap: Record<string, string>;
}

export interface NormalizedCommentInput {
  id: string;
  dynamicId: string;
  rootId?: string | null;
  parentId?: string | null;
  authorUid: string;
  authorName: string;
  avatarUrl?: string | null;
  message: string;
  likeCount?: number;
  replyCount?: number;
  isPinned?: boolean;
  isStreamer?: boolean;
  publishedAt: string;
  mediaUrls?: string[];
}

export async function ensureInitialAdmin(): Promise<void> {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) AS count FROM admins').get() as Row;
  if (number(count.count) > 0) return;
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!initialPassword) return;
  const timestamp = now();
  db.prepare(`INSERT INTO admins(id, username, password_hash, force_password_change, created_at, updated_at)
              VALUES (?, 'admin', ?, 1, ?, ?)`)
    .run(randomUUID(), await hashPassword(initialPassword), timestamp, timestamp);
}

export function findAdminByUsername(username: string): Row | null {
  return (getDb().prepare('SELECT * FROM admins WHERE username = ?').get(username) as Row | undefined) ?? null;
}

export function createAdminSession(adminId: string): string {
  const { token, hash } = createOpaqueToken('session');
  const timestamp = now();
  getDb().prepare(`INSERT INTO admin_sessions(token_hash, admin_id, expires_at, created_at, last_seen_at)
                   VALUES (?, ?, ?, ?, ?)`)
    .run(hash, adminId, new Date(Date.now() + config.sessionTtlMs).toISOString(), timestamp, timestamp);
  return token;
}

export function resolveAdminSession(token: string | undefined): { adminId: string; username: string; forcePasswordChange: boolean } | null {
  if (!token) return null;
  const row = getDb().prepare(`SELECT a.id AS admin_id, a.username, a.force_password_change, s.expires_at
                               FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
                               WHERE s.token_hash = ?`).get(hashToken(token)) as Row | undefined;
  if (!row || String(row.expires_at) <= now()) return null;
  getDb().prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), hashToken(token));
  return { adminId: String(row.admin_id), username: String(row.username), forcePasswordChange: bool(row.force_password_change) };
}

export function deleteAdminSession(token: string): void {
  getDb().prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
}

export async function changeAdminPassword(adminId: string, password: string, actor = 'admin-ui'): Promise<void> {
  const encoded = await hashPassword(password);
  withTransaction((db) => {
    db.prepare('UPDATE admins SET password_hash=?,force_password_change=0,updated_at=? WHERE id=?')
      .run(encoded, now(), adminId);
    insertAudit(db, actor, adminId, 'admin.password.change', 'admin', adminId, null, { password: '[REDACTED]' });
  });
}

export function listStreamerSummaries(): StreamerSummary[] {
  const rows = getDb().prepare(`
    SELECT s.id, s.slug, s.name, s.bili_uid, s.room_id, s.avatar_url,
           COALESCE(ls.status, 'unknown') AS live_status, ls.title AS live_title,
           ls.checked_at,
           f.predicted_start_at, f.confidence, f.source AS forecast_source,
           f.reason AS forecast_reason, f.stale AS forecast_stale
    FROM streamers s
    LEFT JOIN live_state ls ON ls.streamer_id = s.id
    LEFT JOIN forecasts f ON f.id = (
      SELECT id FROM forecasts WHERE streamer_id = s.id AND active = 1 ORDER BY created_at DESC LIMIT 1
    )
    WHERE s.enabled = 1
    ORDER BY CASE COALESCE(ls.status, 'unknown') WHEN 'live' THEN 0 WHEN 'rotating' THEN 1 ELSE 2 END,
             COALESCE(f.predicted_start_at, '9999-12-31'), s.name
  `).all() as Row[];
  return rows.map(rowToSummary);
}

export function listAdminStreamers(): Array<StreamerSummary & { enabled: boolean; version: number; dynamicUrl: string; liveUrl: string;
  livePollSeconds: number; dynamicPollSeconds: number }> {
  const summaries = new Map(listStreamerSummaries().map((item) => [item.id, item]));
  const rows = getDb().prepare('SELECT * FROM streamers ORDER BY created_at').all() as Row[];
  return rows.map((row) => ({
    ...(summaries.get(String(row.id)) ?? rowToSummary({ ...row, live_status: 'unknown' })),
    enabled: bool(row.enabled),
    version: number(row.version),
    dynamicUrl: String(row.dynamic_url),
    liveUrl: String(row.live_url),
    livePollSeconds: number(row.live_poll_seconds),
    dynamicPollSeconds: number(row.dynamic_poll_seconds)
  }));
}

export function getStreamerBySlug(slug: string): (StreamerSummary & { timezone: string }) | null {
  const row = getDb().prepare(`
    SELECT s.*, COALESCE(ls.status, 'unknown') AS live_status, ls.title AS live_title, ls.checked_at,
           f.predicted_start_at, f.confidence, f.source AS forecast_source, f.reason AS forecast_reason,
           f.stale AS forecast_stale
    FROM streamers s
    LEFT JOIN live_state ls ON ls.streamer_id = s.id
    LEFT JOIN forecasts f ON f.id = (
      SELECT id FROM forecasts WHERE streamer_id = s.id AND active = 1 ORDER BY created_at DESC LIMIT 1
    )
    WHERE s.slug = ?
  `).get(slug) as Row | undefined;
  return row ? { ...rowToSummary(row), timezone: String(row.timezone) } : null;
}

export function getStreamerById(id: string): Row | null {
  return (getDb().prepare('SELECT * FROM streamers WHERE id = ?').get(id) as Row | undefined) ?? null;
}

export function createStreamer(input: StreamerInput, actor = 'admin-ui'): string {
  validateStreamerInput(input);
  const id = randomUUID();
  const timestamp = now();
  const row = {
    id,
    slug: normalizeSlug(input.slug),
    name: input.name.trim(),
    biliUid: input.biliUid.trim(),
    roomId: input.roomId.trim(),
    dynamicUrl: input.dynamicUrl?.trim() || `https://space.bilibili.com/${input.biliUid.trim()}/dynamic`,
    liveUrl: input.liveUrl?.trim() || `https://live.bilibili.com/${input.roomId.trim()}`,
    avatarUrl: input.avatarUrl ?? null,
    timezone: input.timezone ?? config.timezone,
    enabled: input.enabled === false ? 0 : 1,
    livePollSeconds: clamp(input.livePollSeconds ?? 30, 15, 600),
    dynamicPollSeconds: clamp(input.dynamicPollSeconds ?? 300, 180, 3600)
  };
  withTransaction((db) => {
    db.prepare(`INSERT INTO streamers(id, slug, name, bili_uid, room_id, dynamic_url, live_url, avatar_url,
                timezone, enabled, live_poll_seconds, dynamic_poll_seconds, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.slug, row.name, row.biliUid, row.roomId, row.dynamicUrl, row.liveUrl, row.avatarUrl,
        row.timezone, row.enabled, row.livePollSeconds, row.dynamicPollSeconds, timestamp, timestamp);
    db.prepare(`INSERT INTO live_state(streamer_id, status) VALUES (?, 'unknown')`).run(id);
    db.prepare(`INSERT INTO pi_event_cursors(streamer_id, updated_at) VALUES (?, ?)`).run(id, timestamp);
    insertAudit(db, actor, null, 'streamer.create', 'streamer', id, null, row);
  });
  enqueueJob('sync_streamer', id, {}, 10, timestamp, `initial-sync:${id}`);
  return id;
}

export function updateStreamer(id: string, input: Partial<StreamerInput>, expectedVersion: number, actor = 'admin-ui'): void {
  const before = getStreamerById(id);
  if (!before) throw new Error('主播不存在');
  if (number(before.version) !== expectedVersion) throw new Error('配置已被其他操作修改，请刷新后重试');
  const merged: StreamerInput = {
    slug: input.slug ?? String(before.slug),
    name: input.name ?? String(before.name),
    biliUid: input.biliUid ?? String(before.bili_uid),
    roomId: input.roomId ?? String(before.room_id),
    dynamicUrl: input.dynamicUrl ?? String(before.dynamic_url),
    liveUrl: input.liveUrl ?? String(before.live_url),
    avatarUrl: input.avatarUrl === undefined ? text(before.avatar_url) : input.avatarUrl,
    timezone: input.timezone ?? String(before.timezone),
    enabled: input.enabled ?? bool(before.enabled),
    livePollSeconds: input.livePollSeconds ?? number(before.live_poll_seconds),
    dynamicPollSeconds: input.dynamicPollSeconds ?? number(before.dynamic_poll_seconds)
  };
  validateStreamerInput(merged);
  const after = {
    slug: normalizeSlug(merged.slug), name: merged.name.trim(), biliUid: merged.biliUid.trim(), roomId: merged.roomId.trim(),
    dynamicUrl: merged.dynamicUrl ?? `https://space.bilibili.com/${merged.biliUid.trim()}/dynamic`,
    liveUrl: merged.liveUrl ?? `https://live.bilibili.com/${merged.roomId.trim()}`,
    avatarUrl: merged.avatarUrl ?? null,
    timezone: merged.timezone ?? config.timezone, enabled: merged.enabled === false ? 0 : 1,
    livePollSeconds: clamp(merged.livePollSeconds ?? 30, 15, 600),
    dynamicPollSeconds: clamp(merged.dynamicPollSeconds ?? 300, 180, 3600)
  };
  withTransaction((db) => {
    const result = db.prepare(`UPDATE streamers SET slug=?, name=?, bili_uid=?, room_id=?, dynamic_url=?, live_url=?,
      avatar_url=?, timezone=?, enabled=?, live_poll_seconds=?, dynamic_poll_seconds=?, updated_at=?, version=version+1
      WHERE id=? AND version=?`).run(after.slug, after.name, after.biliUid, after.roomId, after.dynamicUrl, after.liveUrl,
      after.avatarUrl, after.timezone, after.enabled, after.livePollSeconds, after.dynamicPollSeconds, now(), id, expectedVersion);
    if (Number(result.changes) !== 1) throw new Error('配置版本冲突');
    insertAudit(db, actor, null, 'streamer.update', 'streamer', id, before, after);
  });
}

export function listDynamics(streamerId: string, limit = 20, before?: string): DynamicRecord[] {
  const safeLimit = clamp(limit, 1, 50);
  const rows = getDb().prepare(`SELECT * FROM dynamics WHERE streamer_id = ? AND (? IS NULL OR published_at < ?)
                                ORDER BY published_at DESC, id DESC LIMIT ?`)
    .all(streamerId, before ?? null, before ?? null, safeLimit) as Row[];
  return rows.map((row) => ({
    id: String(row.id), streamerId: String(row.streamer_id), type: String(row.type), text: String(row.text),
    sourceUrl: String(row.source_url), state: String(row.state) as DynamicRecord['state'],
    publishedAt: String(row.published_at), updatedAt: String(row.updated_at), commentCount: number(row.comment_count),
    likeCount: number(row.like_count), media: listMediaFor('dynamic', String(row.id)), emojiMap: parseEmojiMap(row.raw_excerpt)
  }));
}

export function getDynamic(id: string): DynamicRecord | null {
  const row = getDb().prepare('SELECT * FROM dynamics WHERE id = ?').get(id) as Row | undefined;
  if (!row) return null;
  return {
    id: String(row.id), streamerId: String(row.streamer_id), type: String(row.type), text: String(row.text),
    sourceUrl: String(row.source_url), state: String(row.state) as DynamicRecord['state'], publishedAt: String(row.published_at),
    updatedAt: String(row.updated_at), commentCount: number(row.comment_count), likeCount: number(row.like_count),
    media: listMediaFor('dynamic', id), emojiMap: parseEmojiMap(row.raw_excerpt)
  };
}

export function listDynamicRevisions(id: string): DynamicRevisionRecord[] {
  return (getDb().prepare('SELECT id,dynamic_id,text,created_at,snapshot_json FROM dynamic_revisions WHERE dynamic_id=? ORDER BY created_at DESC').all(id) as Row[])
    .map((row) => { const snapshot = safeJson<Row>(String(row.snapshot_json), {}); return { id: String(row.id), dynamicId: String(row.dynamic_id), text: String(row.text),
      createdAt: String(row.created_at), snapshot, media: listMediaByUrls(Array.isArray(snapshot.mediaUrls) ? snapshot.mediaUrls.map(String) : []), emojiMap: parseEmojiMap(snapshot.raw_excerpt) }; });
}

export function getDynamicRevision(id: string, revisionId: string): DynamicRevisionRecord | null {
  const row = getDb().prepare('SELECT id,dynamic_id,text,created_at,snapshot_json FROM dynamic_revisions WHERE id=? AND dynamic_id=?').get(revisionId, id) as Row | undefined;
  if (!row) return null;
  const snapshot = safeJson<Row>(String(row.snapshot_json), {});
  return { id: String(row.id), dynamicId: String(row.dynamic_id), text: String(row.text), createdAt: String(row.created_at), snapshot,
    media: listMediaByUrls(Array.isArray(snapshot.mediaUrls) ? snapshot.mediaUrls.map(String) : []), emojiMap: parseEmojiMap(snapshot.raw_excerpt) };
}

export function markDynamicDeleted(id: string): void {
  getDb().prepare("UPDATE dynamics SET state='deleted',updated_at=? WHERE id=? AND state='visible'").run(now(), id);
}

export function markMissingDynamicsDeleted(streamerId: string, seenIds: string[], since: string): number {
  const exclusion = seenIds.length ? ` AND id NOT IN (${seenIds.map(() => '?').join(',')})` : '';
  const result = getDb().prepare(`UPDATE dynamics SET state='deleted',updated_at=? WHERE streamer_id=? AND published_at>=? AND state='visible'${exclusion}`)
    .run(now(), streamerId, since, ...seenIds);
  return Number(result.changes);
}

export function markMissingDynamicsUnavailable(streamerId: string, seenIds: string[], oldestPublishedAt: string): number {
  if (seenIds.length === 0) return 0;
  const placeholders = seenIds.map(() => '?').join(',');
  const result = getDb().prepare(`UPDATE dynamics SET state='unavailable',updated_at=?
    WHERE streamer_id=? AND state='visible' AND published_at >= ? AND id NOT IN (${placeholders})`)
    .run(now(), streamerId, oldestPublishedAt, ...seenIds);
  return Number(result.changes);
}

export function markMissingRootCommentsUnavailable(dynamicId: string, seenIds: string[]): number {
  const exclusion = seenIds.length ? ` AND id NOT IN (${seenIds.map(() => '?').join(',')})` : '';
  const result = getDb().prepare(`UPDATE comments SET state='unavailable',updated_at=?
    WHERE dynamic_id=? AND root_id IS NULL AND state='visible'${exclusion}`)
    .run(now(), dynamicId, ...seenIds);
  return Number(result.changes);
}

export function markMissingRepliesUnavailable(dynamicId: string, rootId: string, seenIds: string[]): number {
  const exclusion = seenIds.length ? ` AND id NOT IN (${seenIds.map(() => '?').join(',')})` : '';
  const result = getDb().prepare(`UPDATE comments SET state='unavailable',updated_at=?
    WHERE dynamic_id=? AND root_id=? AND state='visible'${exclusion}`)
    .run(now(), dynamicId, rootId, ...seenIds);
  return Number(result.changes);
}

export function listComments(dynamicId: string, limit = 50, before?: string): CommentRecord[] {
  const rows = getDb().prepare(`SELECT * FROM comments WHERE dynamic_id = ? AND root_id IS NULL
                                AND (? IS NULL OR published_at < ?) ORDER BY published_at DESC, id DESC LIMIT ?`)
    .all(dynamicId, before ?? null, before ?? null, clamp(limit, 1, 100)) as Row[];
  return rows.map(rowToComment);
}

export function listReplies(dynamicId: string, rootId: string): CommentRecord[] {
  return (getDb().prepare(`SELECT * FROM comments WHERE dynamic_id = ? AND root_id = ? ORDER BY published_at, id`)
    .all(dynamicId, rootId) as Row[]).map(rowToComment);
}

export function upsertDynamic(input: NormalizedDynamicInput): { created: boolean; changed: boolean } {
  const db = getDb();
  const timestamp = now();
  const hash = contentHash({ type: input.type, text: input.text, media: input.mediaUrls ?? [], emojiMap: input.emojiMap ?? {} });
  const existing = db.prepare('SELECT * FROM dynamics WHERE id = ?').get(input.id) as Row | undefined;
  let changed = false;
  withTransaction((tx) => {
    if (!existing) {
      tx.prepare(`INSERT INTO dynamics(id, streamer_id, type, text, source_url, published_at, updated_at, last_seen_at,
        content_hash, comment_oid, comment_type, comment_count, like_count, raw_excerpt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.streamerId, input.type, input.text, input.sourceUrl, input.publishedAt, timestamp, timestamp,
          hash, input.commentOid ?? null, input.commentType ?? null, input.commentCount ?? 0, input.likeCount ?? 0,
          mergeRawExcerpt(input.rawExcerpt, input.emojiMap));
      tx.prepare(`INSERT INTO comment_sync_state(dynamic_id, next_sync_at, updated_at) VALUES (?, ?, ?)`)
        .run(input.id, timestamp, timestamp);
      changed = true;
    } else {
      changed = String(existing.content_hash) !== hash;
      if (changed) {
        const oldMedia = tx.prepare('SELECT m.source_url FROM media_assets m JOIN dynamic_media dm ON dm.media_id=m.id WHERE dm.dynamic_id=? ORDER BY dm.position').all(input.id) as Row[];
        const snapshot = { ...existing, mediaUrls: oldMedia.map((row) => String(row.source_url)) };
        tx.prepare(`INSERT INTO dynamic_revisions(id, dynamic_id, text, content_hash, snapshot_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), input.id, String(existing.text), String(existing.content_hash), JSON.stringify(snapshot), timestamp);
      }
      tx.prepare(`UPDATE dynamics SET type=?, text=?, source_url=?, state='visible', updated_at=?, last_seen_at=?,
                  content_hash=?, comment_oid=COALESCE(?, comment_oid), comment_type=COALESCE(?, comment_type),
                  comment_count=?, like_count=?, raw_excerpt=? WHERE id=?`)
        .run(input.type, input.text, input.sourceUrl, timestamp, timestamp, hash, input.commentOid ?? null,
          input.commentType ?? null, input.commentCount ?? 0, input.likeCount ?? 0, mergeRawExcerpt(input.rawExcerpt, input.emojiMap), input.id);
    }
    if ((input.mediaUrls ?? []).length > 0) tx.prepare('DELETE FROM dynamic_media WHERE dynamic_id=?').run(input.id);
    linkMediaUrls(tx, 'dynamic', input.id, input.mediaUrls ?? []);
  });
  if (!existing || changed) enqueueJob('pi_analyze', input.streamerId, { dynamicId: input.id }, 30, timestamp, `pi-dynamic:${input.id}:${hash}`);
  enqueueJob('sync_comments', input.id, {}, 50, timestamp, `comments:${input.id}`);
  return { created: !existing, changed };
}

export function upsertComment(input: NormalizedCommentInput): { created: boolean; changed: boolean; highSignal: boolean } {
  const db = getDb();
  const timestamp = now();
  const hash = contentHash({ message: input.message, media: input.mediaUrls ?? [] });
  const existing = db.prepare('SELECT * FROM comments WHERE id = ?').get(input.id) as Row | undefined;
  let changed = false;
  withTransaction((tx) => {
    if (!existing) {
      tx.prepare(`INSERT INTO comments(id, dynamic_id, root_id, parent_id, author_uid, author_name, avatar_url, message,
        like_count, reply_count, is_pinned, is_streamer, content_hash, published_at, updated_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.dynamicId, input.rootId ?? null, input.parentId ?? null, input.authorUid, input.authorName,
          input.avatarUrl ?? null, input.message, input.likeCount ?? 0, input.replyCount ?? 0, input.isPinned ? 1 : 0,
          input.isStreamer ? 1 : 0, hash, input.publishedAt, timestamp, timestamp);
      changed = true;
    } else {
      changed = String(existing.content_hash) !== hash;
      if (changed) {
        tx.prepare(`INSERT INTO comment_revisions(id, comment_id, message, content_hash, snapshot_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), input.id, String(existing.message), String(existing.content_hash), JSON.stringify(existing), timestamp);
      }
      tx.prepare(`UPDATE comments SET author_name=?, avatar_url=?, message=?, like_count=?, reply_count=?, is_pinned=?,
        is_streamer=?, state='visible', content_hash=?, updated_at=?, last_seen_at=? WHERE id=?`)
        .run(input.authorName, input.avatarUrl ?? null, input.message, input.likeCount ?? 0, input.replyCount ?? 0,
          input.isPinned ? 1 : 0, input.isStreamer ? 1 : 0, hash, timestamp, timestamp, input.id);
    }
    linkMediaUrls(tx, 'comment', input.id, input.mediaUrls ?? []);
  });
  const highSignal = Boolean(input.isStreamer || input.isPinned || containsTimeSignal(input.message));
  if ((!existing || changed) && highSignal) {
    const dynamic = getDb().prepare('SELECT streamer_id FROM dynamics WHERE id = ?').get(input.dynamicId) as Row;
    enqueueJob('pi_analyze', String(dynamic.streamer_id), { commentId: input.id }, 35, timestamp, `pi-comment:${input.id}:${hash}`);
  }
  return { created: !existing, changed, highSignal };
}

export function setForecast(input: Omit<ForecastRecord, 'id' | 'createdAt' | 'stale'> & { stale?: boolean }, actor = 'pi'): string {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) throw new Error('置信度必须在 0 到 100 之间');
  const predicted = new Date(input.predictedStartAt);
  if (Number.isNaN(predicted.getTime())) throw new Error('预测时间格式无效');
  if (predicted.getTime() < Date.now() - 60_000) throw new Error('预测时间必须是未来时间');
  if (predicted.getTime() > Date.now() + 8 * 24 * 60 * 60 * 1000) throw new Error('预测时间不能超过未来 8 天');
  const manual = getDb().prepare(`SELECT id FROM forecasts WHERE streamer_id=? AND active=1 AND source='manual' LIMIT 1`)
    .get(input.streamerId);
  if (manual && input.source !== 'manual') throw new Error('人工预测已锁定');
  const id = randomUUID();
  withTransaction((db) => {
    const before = db.prepare('SELECT * FROM forecasts WHERE streamer_id=? AND active=1 ORDER BY created_at DESC LIMIT 1')
      .get(input.streamerId) as Row | undefined;
    db.prepare('UPDATE forecasts SET active=0 WHERE streamer_id=? AND active=1').run(input.streamerId);
    db.prepare(`INSERT INTO forecasts(id, streamer_id, predicted_start_at, confidence, source, reason, evidence_json, stale, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.streamerId, predicted.toISOString(), Math.round(input.confidence), input.source, input.reason,
        JSON.stringify(input.evidence), input.stale ? 1 : 0, now());
    insertAudit(db, actor, null, 'forecast.set', 'forecast', id, before ?? null, input);
  });
  return id;
}

export function rollOverdueForecasts(): number {
  const rows = getDb().prepare(`SELECT f.*, ls.status FROM forecasts f
    LEFT JOIN live_state ls ON ls.streamer_id=f.streamer_id
    WHERE f.active=1 AND f.source!='manual' AND f.predicted_start_at <= ?
      AND COALESCE(ls.status, 'offline') != 'live'`).all(now()) as Row[];
  for (const row of rows) {
    const next = new Date(Math.ceil((Date.now() + 1) / 300000) * 300000);
    setForecast({
      streamerId: String(row.streamer_id), predictedStartAt: next.toISOString(),
      confidence: Math.max(1, number(row.confidence) - 5), source: 'fallback',
      reason: '预测时间已过且仍未开播，系统顺延至下一个 5 分钟刻度。',
      evidence: safeJson(String(row.evidence_json), [])
    }, 'scheduler');
    enqueueJob('pi_analyze', String(row.streamer_id), { reason: 'forecast_overdue' }, 15, now(), `pi-overdue:${row.streamer_id}:${next.toISOString()}`);
  }
  return rows.length;
}

export function updateLiveState(streamerId: string, status: LiveStatus, title: string | null): boolean {
  const normalizedTitle = status === 'offline' || status === 'unknown' ? null : title;
  const before = getDb().prepare('SELECT * FROM live_state WHERE streamer_id=?').get(streamerId) as Row | undefined;
  const changed = !before || String(before.status) !== status;
  const timestamp = now();
  withTransaction((db) => {
    db.prepare(`INSERT INTO live_state(streamer_id, status, title, checked_at, changed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(streamer_id) DO UPDATE SET status=excluded.status, title=excluded.title, checked_at=excluded.checked_at,
      changed_at=CASE WHEN live_state.status != excluded.status THEN excluded.changed_at ELSE live_state.changed_at END`)
      .run(streamerId, status, normalizedTitle, timestamp, timestamp);
    if (changed && status === 'live') {
      db.prepare(`INSERT INTO live_sessions(id, streamer_id, title, observed_start_at, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), streamerId, normalizedTitle, timestamp, timestamp);
    }
    if (changed && status !== 'live' && before?.status === 'live') {
      db.prepare(`UPDATE live_sessions SET observed_end_at=? WHERE id=(SELECT id FROM live_sessions
        WHERE streamer_id=? AND observed_end_at IS NULL ORDER BY observed_start_at DESC LIMIT 1)`).run(timestamp, streamerId);
    }
  });
  if (changed) enqueueJob('pi_analyze', streamerId, { liveStatus: status }, 5, timestamp, `pi-live:${streamerId}:${status}:${timestamp.slice(0, 16)}`);
  return changed;
}

export function enqueueJob(type: string, entityId: string | null, payload: unknown, priority = 100, dueAt = now(), dedupeKey?: string): string {
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO jobs(id, type, entity_id, payload_json, priority, due_at, dedupe_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET due_at=MIN(jobs.due_at, excluded.due_at),
      priority=MIN(jobs.priority, excluded.priority), updated_at=excluded.updated_at,
      status=CASE WHEN jobs.status IN ('done','failed') THEN 'pending' ELSE jobs.status END`)
    .run(id, type, entityId, JSON.stringify(payload ?? {}), priority, dueAt, dedupeKey ?? null, timestamp, timestamp);
  if (!dedupeKey) return id;
  const stored = getDb().prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(dedupeKey) as Row;
  return String(stored.id);
}

export function leaseNextJob(types?: string[]): Row | null {
  return withTransaction((db) => {
    const placeholders = types?.length ? `AND type IN (${types.map(() => '?').join(',')})` : '';
    const row = db.prepare(`SELECT * FROM jobs WHERE status IN ('pending','retry') AND due_at <= ?
      AND (lease_until IS NULL OR lease_until < ?) ${placeholders} ORDER BY priority, due_at LIMIT 1`)
      .get(now(), now(), ...(types ?? [])) as Row | undefined;
    if (!row) return null;
    db.prepare(`UPDATE jobs SET status='running', lease_owner=?, lease_until=?, attempts=attempts+1, updated_at=? WHERE id=?`)
      .run(config.processId, new Date(Date.now() + 5 * 60 * 1000).toISOString(), now(), String(row.id));
    return { ...row, attempts: number(row.attempts) + 1 };
  });
}

export function finishJob(id: string): void {
  getDb().prepare(`UPDATE jobs SET status='done', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE id=?`).run(now(), id);
}

export function failJob(id: string, error: unknown, retryDelayMs: number): void {
  const row = getDb().prepare('SELECT attempts,max_attempts FROM jobs WHERE id=?').get(id) as Row;
  const terminal = number(row.attempts) >= number(row.max_attempts);
  getDb().prepare(`UPDATE jobs SET status=?, due_at=?, lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE id=?`)
    .run(terminal ? 'failed' : 'retry', new Date(Date.now() + retryDelayMs).toISOString(), formatError(error), now(), id);
}

export function listJobs(limit = 50): Row[] {
  return getDb().prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(clamp(limit, 1, 200)) as Row[];
}

export function putSecret(key: string, value: string, actor = 'admin-ui'): void {
  if (!key || !value) throw new Error('密钥名称和值不能为空');
  const before = getDb().prepare('SELECT key,status,updated_at FROM secrets WHERE key=?').get(key) as Row | undefined;
  withTransaction((db) => {
    db.prepare(`INSERT INTO secrets(key, encrypted_value, status, updated_at) VALUES (?, ?, 'untested', ?)
      ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,status='untested',updated_at=excluded.updated_at`)
      .run(key, encryptSecret(value), now());
    insertAudit(db, actor, null, 'secret.write', 'secret', key, before ?? null, { key, value: '[REDACTED]' });
  });
}

export function getSecret(key: string, actor?: string): string | null {
  const row = getDb().prepare('SELECT encrypted_value FROM secrets WHERE key=?').get(key) as Row | undefined;
  if (!row) return null;
  if (actor) insertAudit(getDb(), actor, null, 'secret.read', 'secret', key, null, { key, value: '[REDACTED]' });
  return decryptSecret(String(row.encrypted_value));
}

export function listSecretMetadata(): Row[] {
  return getDb().prepare('SELECT key,status,last_tested_at,updated_at FROM secrets ORDER BY key').all() as Row[];
}

export function updateSecretStatus(key: string, status: 'valid' | 'invalid' | 'untested'): void {
  getDb().prepare('UPDATE secrets SET status=?,last_tested_at=?,updated_at=? WHERE key=?')
    .run(status, now(), now(), key);
}

export function setSetting(key: string, value: unknown, actor = 'admin-ui'): void {
  const before = getDb().prepare('SELECT * FROM settings WHERE key=?').get(key) as Row | undefined;
  withTransaction((db) => {
    db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=settings.version+1,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), now());
    insertAudit(db, actor, null, 'setting.write', 'setting', key, before ?? null, { key, value });
  });
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key=?').get(key) as Row | undefined;
  return row ? safeJson(String(row.value_json), fallback) : fallback;
}

export function createApiToken(name: string, scopes: string[], actor = 'admin-ui'): { id: string; token: string } {
  const id = randomUUID();
  const value = createOpaqueToken('vtbm');
  getDb().prepare(`INSERT INTO api_tokens(id,name,token_prefix,token_hash,scopes_json,created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, name.trim(), value.prefix, value.hash, JSON.stringify([...new Set(scopes)]), now());
  insertAudit(getDb(), actor, null, 'api_token.create', 'api_token', id, null, { name, scopes });
  return { id, token: value.token };
}

export function authenticateApiToken(token: string): { id: string; name: string; scopes: string[] } | null {
  const row = getDb().prepare(`SELECT * FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)`)
    .get(hashToken(token), now()) as Row | undefined;
  if (!row) return null;
  getDb().prepare('UPDATE api_tokens SET last_used_at=? WHERE id=?').run(now(), String(row.id));
  return { id: String(row.id), name: String(row.name), scopes: safeJson(String(row.scopes_json), []) };
}

export function listApiTokens(): Row[] {
  return getDb().prepare(`SELECT id,name,token_prefix,scopes_json,expires_at,last_used_at,revoked_at,created_at
    FROM api_tokens ORDER BY created_at DESC`).all() as Row[];
}

export function upsertAlert(fingerprint: string, severity: string, title: string, message: string): string {
  const existing = getDb().prepare(`SELECT id FROM alerts WHERE fingerprint=? AND status='open'`).get(fingerprint) as Row | undefined;
  if (existing) {
    getDb().prepare(`UPDATE alerts SET occurrences=occurrences+1,last_seen_at=?,message=? WHERE id=?`)
      .run(now(), message, String(existing.id));
    return String(existing.id);
  }
  const id = randomUUID();
  const timestamp = now();
  getDb().prepare(`INSERT INTO alerts(id,fingerprint,severity,title,message,first_seen_at,last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, fingerprint, severity, title, message, timestamp, timestamp);
  enqueueJob('send_alert_email', id, {}, 20, timestamp, `alert-email:${id}`);
  return id;
}

export function listAlerts(status = 'open'): Row[] {
  return getDb().prepare('SELECT * FROM alerts WHERE status=? ORDER BY last_seen_at DESC').all(status) as Row[];
}

export function acknowledgeAlert(id: string, actor = 'admin-ui'): void {
  getDb().prepare(`UPDATE alerts SET status='acknowledged',acknowledged_at=? WHERE id=?`).run(now(), id);
  insertAudit(getDb(), actor, null, 'alert.acknowledge', 'alert', id, null, { status: 'acknowledged' });
}

export function resolveAlert(fingerprint: string, actor = 'system'): void {
  const rows = getDb().prepare("SELECT id FROM alerts WHERE fingerprint=? AND status='open'").all(fingerprint) as Row[];
  if (rows.length === 0) return;
  getDb().prepare("UPDATE alerts SET status='resolved',resolved_at=? WHERE fingerprint=? AND status='open'")
    .run(now(), fingerprint);
  for (const row of rows) insertAudit(getDb(), actor, null, 'alert.resolve', 'alert', String(row.id), null, { status: 'resolved' });
}

export function listAudit(limit = 100): Row[] {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(clamp(limit, 1, 500)) as Row[];
}

export function listScheduleRules(streamerId: string): Row[] {
  return getDb().prepare('SELECT * FROM schedule_rules WHERE streamer_id=? AND active=1 ORDER BY weekday,local_time')
    .all(streamerId) as Row[];
}

export function replacePiScheduleRules(streamerId: string, rules: Array<{ weekday: number; localTime: string; title?: string;
  confidence: number; sourceRef?: string }>, actor = 'pi'): void {
  for (const rule of rules) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 1 || rule.weekday > 7) throw new Error('weekday 必须在 1 到 7 之间');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.localTime)) throw new Error('日程时间必须为 HH:mm');
    if (rule.confidence < 0 || rule.confidence > 100) throw new Error('日程置信度必须在 0 到 100 之间');
  }
  withTransaction((db) => {
    const before = db.prepare("SELECT * FROM schedule_rules WHERE streamer_id=? AND active=1 AND source!='manual'").all(streamerId);
    db.prepare("UPDATE schedule_rules SET active=0,updated_at=? WHERE streamer_id=? AND source!='manual' AND locked=0")
      .run(now(), streamerId);
    for (const rule of rules) {
      db.prepare(`INSERT INTO schedule_rules(id,streamer_id,weekday,local_time,title,source,source_ref,confidence,created_at,updated_at)
        VALUES (?, ?, ?, ?, ?, 'pi', ?, ?, ?, ?)`)
        .run(randomUUID(), streamerId, rule.weekday, rule.localTime, rule.title ?? null, rule.sourceRef ?? null,
          Math.round(rule.confidence), now(), now());
    }
    insertAudit(db, actor, null, 'schedule.replace', 'streamer', streamerId, before, rules);
  });
}

export function replaceManualScheduleRules(streamerId: string, rules: Array<{ weekday: number; localTime: string; title?: string }>,
  actor = 'admin-ui'): void {
  for (const rule of rules) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 1 || rule.weekday > 7) throw new Error('周表星期必须在 1 到 7 之间');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.localTime)) throw new Error('周表时间必须为 HH:mm');
  }
  withTransaction((db) => {
    const before = db.prepare("SELECT * FROM schedule_rules WHERE streamer_id=? AND source='manual' AND active=1").all(streamerId);
    db.prepare("UPDATE schedule_rules SET active=0,updated_at=? WHERE streamer_id=? AND source='manual'").run(now(), streamerId);
    for (const rule of rules) {
      db.prepare(`INSERT INTO schedule_rules(id,streamer_id,weekday,local_time,title,source,confidence,locked,created_at,updated_at)
        VALUES (?, ?, ?, ?, ?, 'manual', 100, 1, ?, ?)`)
        .run(randomUUID(), streamerId, rule.weekday, rule.localTime, rule.title?.trim() || null, now(), now());
    }
    insertAudit(db, actor, null, 'schedule.manual.replace', 'streamer', streamerId, before, rules);
  });
}

export function upsertScheduleException(streamerId: string, exception: { occurrenceDate: string; startAt?: string | null;
  status: 'scheduled' | 'delayed' | 'cancelled'; title?: string; confidence: number; sourceRef: string }, actor = 'pi'): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.occurrenceDate)) throw new Error('日期必须为 YYYY-MM-DD');
  if (exception.startAt && Number.isNaN(new Date(exception.startAt).getTime())) throw new Error('例外时间格式无效');
  const existing = getDb().prepare(`SELECT * FROM schedule_exceptions WHERE streamer_id=? AND occurrence_date=? AND source_ref=?`)
    .get(streamerId, exception.occurrenceDate, exception.sourceRef) as Row | undefined;
  if (existing && bool(existing.locked)) throw new Error('该日程例外已被人工锁定');
  withTransaction((db) => {
    db.prepare(`INSERT INTO schedule_exceptions(id,streamer_id,occurrence_date,start_at,status,title,source,source_ref,
      confidence,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pi', ?, ?, ?, ?)
      ON CONFLICT(streamer_id,occurrence_date,source_ref) DO UPDATE SET start_at=excluded.start_at,status=excluded.status,
      title=excluded.title,confidence=excluded.confidence,updated_at=excluded.updated_at,version=schedule_exceptions.version+1
      WHERE schedule_exceptions.locked=0`)
      .run(existing ? String(existing.id) : randomUUID(), streamerId, exception.occurrenceDate, exception.startAt ?? null, exception.status,
        exception.title ?? null, exception.sourceRef, Math.round(exception.confidence), now(), now());
    insertAudit(db, actor, null, 'schedule.exception.upsert', 'streamer', streamerId, existing ?? null, exception);
  });
}

export function recordAiUsage(input: { provider: string; model: string; purpose: string; streamerId?: string;
  inputTokens?: number; outputTokens?: number; cost?: number; success: boolean; error?: string }): void {
  getDb().prepare(`INSERT INTO ai_usage(id,provider,model,purpose,streamer_id,input_tokens,output_tokens,cost,success,error,created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), input.provider, input.model, input.purpose, input.streamerId ?? null, input.inputTokens ?? null,
      input.outputTokens ?? null, input.cost ?? null, input.success ? 1 : 0, input.error?.slice(0, 2000) ?? null, now());
}

export function getDashboardStats(): Record<string, number> {
  const db = getDb();
  const scalar = (sql: string) => number((db.prepare(sql).get() as Row).count);
  return {
    streamers: scalar('SELECT COUNT(*) AS count FROM streamers WHERE enabled=1'),
    dynamics: scalar('SELECT COUNT(*) AS count FROM dynamics'),
    comments: scalar('SELECT COUNT(*) AS count FROM comments'),
    pendingJobs: scalar("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending','retry','running')"),
    openAlerts: scalar("SELECT COUNT(*) AS count FROM alerts WHERE status='open'")
  };
}

function listMediaFor(kind: 'dynamic' | 'comment', id: string): MediaAsset[] {
  const link = kind === 'dynamic' ? 'dynamic_media' : 'comment_media';
  const column = kind === 'dynamic' ? 'dynamic_id' : 'comment_id';
  const rows = getDb().prepare(`SELECT m.* FROM media_assets m JOIN ${link} l ON l.media_id=m.id
                                WHERE l.${column}=? ORDER BY l.position`).all(id) as Row[];
  return rows.map((row) => ({
    id: String(row.id), sha256: text(row.sha256), sourceUrl: String(row.source_url),
    localUrl: row.local_path ? `/media/${String(row.id)}` : null, mimeType: text(row.mime_type),
    byteSize: row.byte_size == null ? null : number(row.byte_size), state: String(row.state) as MediaAsset['state']
  }));
}

function listMediaByUrls(urls: string[]): MediaAsset[] {
  if (urls.length === 0) return [];
  const rows = getDb().prepare(`SELECT * FROM media_assets WHERE source_url IN (${urls.map(() => '?').join(',')})`).all(...urls) as Row[];
  const byUrl = new Map(rows.map((row) => [String(row.source_url), row]));
  return urls.map((url) => byUrl.get(url)).filter((row): row is Row => Boolean(row)).map((row) => ({
    id: String(row.id), sha256: text(row.sha256), sourceUrl: String(row.source_url), localUrl: row.local_path ? `/media/${String(row.id)}` : null,
    mimeType: text(row.mime_type), byteSize: row.byte_size == null ? null : number(row.byte_size), state: String(row.state) as MediaAsset['state']
  }));
}

function mergeRawExcerpt(raw: string | null | undefined, emojiMap?: Record<string, string>): string | null {
  if (!raw && !emojiMap) return null;
  let value: Row = {};
  try { value = raw ? JSON.parse(raw) as Row : {}; } catch { value = { excerpt: raw }; }
  if (emojiMap && Object.keys(emojiMap).length > 0) value.emojiMap = emojiMap;
  return JSON.stringify(value).slice(0, 4000);
}

function parseEmojiMap(raw: unknown): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(String(raw)) as Row;
    return value.emojiMap && typeof value.emojiMap === 'object' ? value.emojiMap as Record<string, string> : {};
  } catch { return {}; }
}

function linkMediaUrls(db: ReturnType<typeof getDb>, kind: 'dynamic' | 'comment', ownerId: string, urls: string[]): void {
  const link = kind === 'dynamic' ? 'dynamic_media' : 'comment_media';
  const column = kind === 'dynamic' ? 'dynamic_id' : 'comment_id';
  urls.forEach((rawSourceUrl, position) => {
    const sourceUrl = /^http:\/\/i0\.hdslb\.com\//i.test(rawSourceUrl) ? rawSourceUrl.replace(/^http:/i, 'https:') : rawSourceUrl;
    let media = db.prepare('SELECT id FROM media_assets WHERE source_url=? ORDER BY created_at LIMIT 1').get(sourceUrl) as Row | undefined;
    if (!media) {
      media = { id: randomUUID() };
      const mediaId = String(media.id);
      db.prepare(`INSERT INTO media_assets(id,source_url,created_at,updated_at) VALUES (?, ?, ?, ?)`)
        .run(mediaId, sourceUrl, now(), now());
        enqueueJob('download_media', mediaId, {}, 20, now(), `media:${contentHash(sourceUrl)}`);
    }
    const mediaId = String(media.id);
    db.prepare(`INSERT INTO ${link}(${column},media_id,position) VALUES (?, ?, ?)
                ON CONFLICT(${column},media_id) DO UPDATE SET position=excluded.position`)
      .run(ownerId, mediaId, position);
  });
}

function rowToSummary(row: Row): StreamerSummary {
  return {
    id: String(row.id), slug: String(row.slug), name: String(row.name), biliUid: String(row.bili_uid),
    roomId: String(row.room_id), avatarUrl: text(row.avatar_url), liveStatus: String(row.live_status) as LiveStatus,
    liveTitle: text(row.live_title), predictedStartAt: text(row.predicted_start_at),
    confidence: row.confidence == null ? null : number(row.confidence), forecastSource: row.forecast_source as StreamerSummary['forecastSource'] ?? null,
    forecastReason: text(row.forecast_reason), forecastStale: bool(row.forecast_stale), lastCheckedAt: text(row.checked_at)
  };
}

function rowToComment(row: Row): CommentRecord {
  return {
    id: String(row.id), dynamicId: String(row.dynamic_id), rootId: text(row.root_id), parentId: text(row.parent_id),
    authorUid: String(row.author_uid), authorName: String(row.author_name), avatarUrl: text(row.avatar_url),
    message: String(row.message), likeCount: number(row.like_count), replyCount: number(row.reply_count),
    isPinned: bool(row.is_pinned), isStreamer: bool(row.is_streamer), state: String(row.state) as CommentRecord['state'],
    publishedAt: String(row.published_at), media: listMediaFor('comment', String(row.id))
  };
}

function insertAudit(db: ReturnType<typeof getDb>, actorType: string, actorId: string | null, action: string,
  entityType: string, entityId: string | null, before: unknown, after: unknown): void {
  db.prepare(`INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), actorType, actorId, action, entityType, entityId,
      before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), now());
}

function validateStreamerInput(input: StreamerInput): void {
  if (!input.name.trim()) throw new Error('主播名称不能为空');
  if (!/^\d+$/.test(input.biliUid.trim())) throw new Error('B站 UID 必须为数字');
  if (!/^\d+$/.test(input.roomId.trim())) throw new Error('直播间号必须为数字');
  if (!normalizeSlug(input.slug)) throw new Error('slug 不能为空');
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

function containsTimeSignal(message: string): boolean {
  return /(周表|开播|直播|今晚|明晚|今天|明天|后天|迟到|晚点|推迟|延后|请假|休息|加播|\d{1,2}\s*[:：点时]\s*\d{0,2})/i.test(message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
}
