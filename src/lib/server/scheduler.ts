import { BilibiliClient, BilibiliError } from './bilibili';
import { config } from './config';
import { getDb } from './db';
import { downloadMediaAsset } from './media';
import {
  enqueueJob, failJob, finishJob, getSecret, leaseNextJob, rollOverdueForecasts,
  markMissingRepliesUnavailable, markMissingRootCommentsUnavailable,
  resolveAlert, updateLiveState, updateSecretStatus, upsertAlert, upsertComment, upsertDynamic, markDynamicDeleted, markMissingDynamicsDeleted
} from './store';
import { sendAlertEmail } from './alerts';
import { analyzeStreamerWithPi } from './pi';

type Row = Record<string, any>;

let scheduler: Scheduler | undefined;

export function startScheduler(): Scheduler {
  scheduler ??= new Scheduler();
  scheduler.start();
  return scheduler;
}

export function stopScheduler(): void {
  scheduler?.stop();
  scheduler = undefined;
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private workerActive = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timers.push(setInterval(() => void this.pollLive(), config.livePollSeconds * 1000));
    this.timers.push(setInterval(() => this.enqueueDueDynamicSyncs(), 30_000));
    this.timers.push(setInterval(() => rollOverdueForecasts(), 60_000));
    this.timers.push(setInterval(() => void this.work(), 750));
    void this.pollLive();
    this.enqueueDueDynamicSyncs();
    void this.work();
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private enqueueDueDynamicSyncs(): void {
    const rows = getDb().prepare(`SELECT id,dynamic_poll_seconds,last_dynamic_sync_at,last_dynamic_full_sync_at FROM streamers WHERE enabled=1`).all() as Row[];
    const timestamp = Date.now();
    for (const row of rows) {
      const last = row.last_dynamic_sync_at ? new Date(String(row.last_dynamic_sync_at)).getTime() : 0;
      if (timestamp - last >= Number(row.dynamic_poll_seconds) * 1000) {
        const bucket = Math.floor(timestamp / (Number(row.dynamic_poll_seconds) * 1000));
        enqueueJob('sync_streamer', String(row.id), {}, 20, new Date().toISOString(), `periodic-sync:${row.id}:${bucket}`);
      }
      const fullLast = row.last_dynamic_full_sync_at ? new Date(String(row.last_dynamic_full_sync_at)).getTime() : 0;
      if (timestamp - fullLast >= 24 * 3600_000) {
        const day = Math.floor(timestamp / (24 * 3600_000));
        enqueueJob('sync_streamer', String(row.id), { fullSync: true }, 18, new Date().toISOString(), `daily-full-sync:${row.id}:${day}`);
      }
    }
  }

  private async pollLive(): Promise<void> {
    if (!this.running) return;
    const rows = getDb().prepare('SELECT id,room_id,bili_uid FROM streamers WHERE enabled=1 ORDER BY id').all() as Row[];
    if (rows.length === 0) return;
    const cookie = getSecret('bilibili_cookie');
    try {
      let client = new BilibiliClient(cookie);
      let states;
      try {
        states = await client.fetchLiveStates(rows.map((row) => ({ roomId: String(row.room_id), biliUid: String(row.bili_uid) })));
      } catch (error) {
        if (!cookie || !isInvalidCookie(error)) throw error;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '直播状态抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = new BilibiliClient(null);
        states = await client.fetchLiveStates(rows.map((row) => ({ roomId: String(row.room_id), biliUid: String(row.bili_uid) })));
      }
      for (const row of rows) {
        const state = states.get(String(row.room_id));
        if (state) updateLiveState(String(row.id), state.status, state.title);
      }
    } catch (error) {
      upsertAlert('bilibili-live-poll', 'warning', '直播状态抓取失败', formatError(error));
    }
  }

  private async work(): Promise<void> {
    if (!this.running || this.workerActive) return;
    this.workerActive = true;
    try {
      while (this.running) {
        const job = leaseNextJob();
        if (!job) break;
        try {
          await this.execute(job);
          finishJob(String(job.id));
        } catch (error) {
          const delay = backoffDelay(Number(job.attempts), error);
          failJob(String(job.id), error, delay);
          if (Number(job.attempts) >= 3 && String(job.type) !== 'send_alert_email') {
            upsertAlert(`job:${job.type}:${job.entity_id}`, 'warning', `任务连续失败：${job.type}`, formatError(error));
          }
        }
      }
    } finally {
      this.workerActive = false;
    }
  }

  private async execute(job: Row): Promise<void> {
    const payload = safeJson(String(job.payload_json ?? '{}'));
    switch (job.type) {
      case 'sync_streamer': return this.syncStreamer(String(job.entity_id), payload);
      case 'refresh_dynamic': return this.refreshDynamic(String(job.entity_id));
      case 'sync_comments': return this.syncComments(String(job.entity_id));
      case 'sync_sub_replies': return this.syncSubReplies(payload);
      case 'download_media': return downloadMediaAsset(String(job.entity_id));
      case 'pi_analyze': return analyzeStreamerWithPi(String(job.entity_id), payload);
      case 'send_alert_email': return sendAlertEmail(String(job.entity_id));
      case 'validate_cookie': return this.validateCookie();
      default: throw new Error(`未知任务类型：${job.type}`);
    }
  }

  private async validateCookie(): Promise<void> {
    const cookie = getSecret('bilibili_cookie');
    if (!cookie) return;
    try {
      const result = await new BilibiliClient(cookie).validateCookie();
      if (!result.loggedIn) {
        updateSecretStatus('bilibili_cookie', 'invalid');
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', 'Cookie 未登录，抓取任务将自动尝试匿名模式。');
        return;
      }
      updateSecretStatus('bilibili_cookie', 'valid');
      resolveAlert('bilibili-cookie-invalid', 'scheduler');
    } catch (error) {
      if (isInvalidCookie(error)) {
        updateSecretStatus('bilibili_cookie', 'invalid');
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', 'Cookie 返回 -101，抓取任务将自动尝试匿名模式。');
        return;
      }
      throw error;
    }
  }

  private async syncStreamer(streamerId: string, payload: Row = {}): Promise<void> {
    const streamer = getDb().prepare('SELECT * FROM streamers WHERE id=?').get(streamerId) as Row | undefined;
    if (!streamer) return;
    const fullSync = Boolean(payload.fullSync);
    const initializing = !streamer.dynamic_history_initialized_at;
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    const cookie = getSecret('bilibili_cookie');
    let client = new BilibiliClient(cookie);
    let dynamics;
    try {
      dynamics = await client.fetchSpaceDynamics(String(streamer.bili_uid), (initializing || fullSync) ? 1000 : 30, (initializing || fullSync) ? since.toISOString() : undefined);
    } catch (error) {
      if (cookie && isInvalidCookie(error)) {
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '已自动回退到匿名抓取，请尽快在后台更新 Cookie。');
        client = new BilibiliClient(null);
        dynamics = await client.fetchSpaceDynamics(String(streamer.bili_uid), (initializing || fullSync) ? 1000 : 30, (initializing || fullSync) ? since.toISOString() : undefined);
      } else {
        if (error instanceof BilibiliError && (error.status === 412 || error.code === 412)) {
          upsertAlert('bilibili-dynamic-rate-limited', 'warning', cookie ? '动态请求被 B站 风控拦截' : '动态抓取需要 B站 Cookie',
            cookie ? 'B站返回 HTTP 412，请等待冷却后重试。' : '匿名动态接口返回 HTTP 412，请在后台配置当前有效的 B站 Cookie。');
        }
        throw error;
      }
    }
    let detailBudget = (initializing || fullSync) ? Number.POSITIVE_INFINITY : 20;
    let detailsFetched = 0;
    for (const dynamic of dynamics) {
      const existing = getDb().prepare('SELECT text,raw_excerpt FROM dynamics WHERE id=?').get(dynamic.id) as Row | undefined;
      let enriched = dynamic;
      if (detailBudget > 0 && (initializing || fullSync || !existing || !String(existing.text ?? '').trim() ||
        (String(existing.text ?? '').includes('[') && !String(existing.raw_excerpt ?? '').includes('"emojiMap"')))) {
        try {
          // 添加延迟以避免触发B站风控（第一个请求不延迟）
          if (detailsFetched > 0) {
            await delay(2000 + Math.floor(Math.random() * 1000)); // 2-3秒随机延迟
          }
          const detail = await client.fetchDynamicDetail(dynamic.id);
          enriched = { ...dynamic, text: detail.text || dynamic.text,
            mediaUrls: [...new Set([...(dynamic.mediaUrls ?? []), ...(detail.mediaUrls ?? [])])],
            emojiMap: detail.emojiMap, commentOid: detail.commentOid ?? dynamic.commentOid, commentType: detail.commentType ?? dynamic.commentType };
          detailsFetched += 1;
        } catch (error) {
          // 只在非412错误时创建告警，避免告警泛滥
          if (!(error instanceof BilibiliError && (error.code === -412 || error.status === 412))) {
            upsertAlert(`dynamic-detail:${dynamic.id}`, 'info', '动态详情解析失败', formatError(error));
          }
        }
        detailBudget -= 1;
      }
      upsertDynamic({ ...enriched, streamerId });
      if (dynamic.avatarUrl) getDb().prepare('UPDATE streamers SET avatar_url=COALESCE(avatar_url,?),updated_at=? WHERE id=?').run(dynamic.avatarUrl, new Date().toISOString(), streamerId);
    }
    if (initializing || fullSync) markMissingDynamicsDeleted(streamerId, dynamics.map((item) => item.id), since.toISOString());
    if (initializing || fullSync) getDb().prepare('UPDATE streamers SET dynamic_history_initialized_at=COALESCE(dynamic_history_initialized_at,?),last_dynamic_full_sync_at=?,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), streamerId);
    getDb().prepare('UPDATE streamers SET last_dynamic_sync_at=?,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), new Date().toISOString(), streamerId);
  }

  private async syncComments(dynamicId: string): Promise<void> {
    const dynamic = getDb().prepare(`SELECT d.*,s.bili_uid FROM dynamics d JOIN streamers s ON s.id=d.streamer_id WHERE d.id=?`)
      .get(dynamicId) as Row | undefined;
    if (!dynamic) return;
    const state = getDb().prepare('SELECT * FROM comment_sync_state WHERE dynamic_id=?').get(dynamicId) as Row | undefined;
    const cookie = getSecret('bilibili_cookie');
    let client = new BilibiliClient(cookie);
    let anonymousFallback = false;
    const callWithCookieFallback = async <T>(operation: (activeClient: BilibiliClient) => Promise<T>): Promise<T> => {
      try { return await operation(client); }
      catch (error) {
        if (!cookie || anonymousFallback || !isInvalidCookie(error)) throw error;
        anonymousFallback = true;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '评论抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = new BilibiliClient(null);
        return operation(client);
      }
    };
    let oid = dynamic.comment_oid ? String(dynamic.comment_oid) : '';
    let type = dynamic.comment_type ? String(dynamic.comment_type) : '';
    if (!oid || !type) {
      const context = await callWithCookieFallback((activeClient) => activeClient.fetchDynamicCommentContext(dynamicId));
      oid = context.oid;
      type = context.type;
      getDb().prepare('UPDATE dynamics SET comment_oid=?,comment_type=? WHERE id=?').run(oid, type, dynamicId);
    }
    let offset = state && !Number(state.is_complete) ? String(state.offset ?? '') : '';
    const initialOffset = offset;
    const seenRootIds: string[] = [];
    let complete = false;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      if (pageIndex > 0) await delay(config.commentPageDelayMs + Math.floor(Math.random() * 500));
      const page = await callWithCookieFallback((activeClient) => activeClient.fetchCommentPage(oid, type, offset));
      for (const comment of page.comments) {
        upsertComment({ ...comment, dynamicId, isStreamer: comment.authorUid === String(dynamic.bili_uid) });
        if (!comment.rootId) seenRootIds.push(comment.id);
      }
      for (const top of page.topReplies) {
        const rootId = String(top.rpid_str ?? top.rpid);
        const loaded = Array.isArray(top.replies) ? top.replies.length : 0;
        const total = Number(top.rcount ?? 0);
        if (total > loaded) {
          enqueueJob('sync_sub_replies', dynamicId, { dynamicId, oid, type, rootId, totalPages: Math.ceil(total / 20), startPage: 1,
            streamerUid: String(dynamic.bili_uid) }, 60, new Date().toISOString(), `sub:${dynamicId}:${rootId}:1`);
        }
      }
      offset = page.nextOffset;
      complete = page.isEnd || !offset;
      if (complete) break;
    }
    const nextSyncAt = nextCommentSyncTime(String(dynamic.published_at));
    getDb().prepare(`UPDATE comment_sync_state SET offset=?,is_complete=?,last_full_sync_at=CASE WHEN ?=1 THEN ? ELSE last_full_sync_at END,
      next_sync_at=?,last_error=NULL,updated_at=? WHERE dynamic_id=?`)
      .run(complete ? null : offset, complete ? 1 : 0, complete ? 1 : 0, new Date().toISOString(), nextSyncAt,
        new Date().toISOString(), dynamicId);
    if (complete && !initialOffset) markMissingRootCommentsUnavailable(dynamicId, seenRootIds);
    getDb().prepare('UPDATE streamers SET last_comment_sync_at=? WHERE id=?').run(new Date().toISOString(), dynamic.streamer_id);
    if (!complete) enqueueJob('sync_comments', dynamicId, {}, 55, new Date(Date.now() + 5000).toISOString(), `comments:${dynamicId}:continue:${offset}`);
    else enqueueJob('sync_comments', dynamicId, {}, 90, nextSyncAt, `comments:${dynamicId}:next:${nextSyncAt.slice(0, 13)}`);
  }

  private async syncSubReplies(payload: Row): Promise<void> {
    const cookie = getSecret('bilibili_cookie');
    let client = new BilibiliClient(cookie);
    let anonymousFallback = false;
    const callWithCookieFallback = async <T>(operation: (activeClient: BilibiliClient) => Promise<T>): Promise<T> => {
      try { return await operation(client); }
      catch (error) {
        if (!cookie || anonymousFallback || !isInvalidCookie(error)) throw error;
        anonymousFallback = true;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '楼中楼抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = new BilibiliClient(null);
        return operation(client);
      }
    };
    const start = Number(payload.startPage ?? 1);
    const end = Math.min(Number(payload.totalPages ?? start), start + 9);
    const seenIds: string[] = [];
    for (let page = start; page <= end; page += 1) {
      if (page > start) await delay(config.commentPageDelayMs + Math.floor(Math.random() * 500));
      const comments = await callWithCookieFallback((activeClient) => activeClient.fetchSubReplies(String(payload.oid), String(payload.type), String(payload.rootId), page));
      for (const comment of comments) {
        upsertComment({ ...comment, dynamicId: String(payload.dynamicId), isStreamer: comment.authorUid === String(payload.streamerUid) });
        seenIds.push(comment.id);
      }
      if (start === 1 && end >= Number(payload.totalPages)) markMissingRepliesUnavailable(String(payload.dynamicId), String(payload.rootId), seenIds);
    }
    if (end < Number(payload.totalPages)) {
      const next = end + 1;
      enqueueJob('sync_sub_replies', String(payload.dynamicId), { ...payload, startPage: next }, 65,
        new Date(Date.now() + 5000).toISOString(), `sub:${payload.dynamicId}:${payload.rootId}:${next}`);
    }
  }

  private async refreshDynamic(dynamicId: string): Promise<void> {
    const row = getDb().prepare('SELECT streamer_id FROM dynamics WHERE id=?').get(dynamicId) as Row | undefined;
    if (!row) return;
    const cookie = getSecret('bilibili_cookie');
    try {
      const detail = await new BilibiliClient(cookie).fetchDynamicDetail(dynamicId);
      const current = getDb().prepare('SELECT * FROM dynamics WHERE id=?').get(dynamicId) as Row;
      upsertDynamic({ id: dynamicId, streamerId: String(row.streamer_id), type: String(current.type), text: detail.text, sourceUrl: String(current.source_url),
        publishedAt: String(current.published_at), commentOid: detail.commentOid, commentType: detail.commentType, commentCount: Number(current.comment_count), likeCount: Number(current.like_count),
        mediaUrls: detail.mediaUrls, emojiMap: detail.emojiMap });
    } catch (error) {
      if (error instanceof BilibiliError && [404, 410].includes(Number(error.status))) markDynamicDeleted(dynamicId);
      else throw error;
    }
  }
}

function nextCommentSyncTime(publishedAt: string): string {
  const age = Date.now() - new Date(publishedAt).getTime();
  const delayMs = age < 24 * 3600_000 ? 5 * 60_000
    : age < 7 * 24 * 3600_000 ? 60 * 60_000
      : age < 30 * 24 * 3600_000 ? 24 * 3600_000 : 7 * 24 * 3600_000;
  return new Date(Date.now() + delayMs).toISOString();
}

function backoffDelay(attempt: number, error: unknown): number {
  if (error instanceof BilibiliError && (error.code === 412 || error.status === 412 || error.code === 429)) return 60 * 60_000;
  return Math.min(60 * 60_000, Math.max(5000, 2 ** Math.min(attempt, 10) * 1000));
}

function isInvalidCookie(error: unknown): boolean {
  return error instanceof BilibiliError && (error.code === -101 || error.code === -352);
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(value: string): Row { try { return JSON.parse(value) as Row; } catch { return {}; } }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
