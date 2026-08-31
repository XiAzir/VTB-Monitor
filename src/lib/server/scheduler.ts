import { randomUUID } from 'node:crypto';
import { BilibiliClient, BilibiliError } from './bilibili';
import { config } from './config';
import { getDb } from './db';
import { downloadMediaAsset } from './media';
import {
  acquireServiceLease, enqueueJob, failJob, finishJob, getDynamic, getLatestCompleteDynamicSnapshot, getSecret, getSetting, leaseNextJob, releaseServiceLease, rollOverdueForecasts,
  markMissingRepliesUnavailable, markMissingRootCommentsUnavailable,
  resolveAlert, updateLiveState, updateRoomMapping, updateSecretStatus, upsertAlert, upsertComment, upsertDynamic,
  markDynamicDeleted, markMissingDynamicsDeleted, queuePiDynamicBatch, queuePiRevisionAnalysis, stagePiDynamicIds
} from './store';
import { sendAlertEmail } from './alerts';
import { analyzeDynamicRevisionWithPi, analyzeStreamerWithPi, recognizeScheduleDraftWithPi } from './pi';
import { cleanupStorage } from './storage-maintenance';

type Row = Record<string, any>;

let scheduler: Scheduler | undefined;

function createBilibiliClient(cookie: string | null): BilibiliClient {
  return new BilibiliClient(cookie, getSetting<string | null>('bilibili_proxy_url', null));
}

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
  private readonly workerLeaseOwner = `${config.processId}:${randomUUID()}`;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timers.push(setInterval(() => void this.pollLive(), 15_000));
    this.timers.push(setInterval(() => this.enqueueDueDynamicSyncs(), 30_000));
    this.timers.push(setInterval(() => rollOverdueForecasts(), 60_000));
    this.timers.push(setInterval(() => enqueueJob('cleanup_storage', null, {}, 95, new Date().toISOString(), `cleanup-storage:${new Date().toISOString().slice(0, 10)}`), 6 * 3600_000));
    this.timers.push(setInterval(() => void this.work(), 750));
    void this.pollLive();
    this.enqueueDueDynamicSyncs();
    enqueueJob('repair_dynamic_archives', null, {}, 70, new Date().toISOString(), `repair-dynamics:${new Date().toISOString().slice(0, 10)}`);
    enqueueJob('cleanup_storage', null, {}, 95, new Date().toISOString(), `cleanup-storage:${new Date().toISOString().slice(0, 10)}`);
    void this.work();
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  enqueueDueDynamicSyncs(): void {
    const rows = getDb().prepare(`SELECT id,dynamic_poll_seconds,last_dynamic_sync_at,last_dynamic_full_sync_at FROM streamers WHERE enabled=1`).all() as Row[];
    const timestamp = Date.now();
    for (const row of rows) {
      const syncQueued = getDb().prepare(`SELECT 1 FROM jobs WHERE type='sync_streamer' AND entity_id=?
        AND status IN ('pending','retry','running') LIMIT 1`).get(String(row.id));
      if (syncQueued) continue;
      const last = row.last_dynamic_sync_at ? new Date(String(row.last_dynamic_sync_at)).getTime() : 0;
      const fullLast = row.last_dynamic_full_sync_at ? new Date(String(row.last_dynamic_full_sync_at)).getTime() : 0;
      if (timestamp - fullLast >= 24 * 3600_000) {
        const day = Math.floor(timestamp / (24 * 3600_000));
        enqueueJob('sync_streamer', String(row.id), { fullSync: true }, 18, new Date().toISOString(), `daily-full-sync:${row.id}:${day}`);
      } else if (timestamp - last >= Number(row.dynamic_poll_seconds) * 1000) {
        const bucket = Math.floor(timestamp / (Number(row.dynamic_poll_seconds) * 1000));
        enqueueJob('sync_streamer', String(row.id), {}, 20, new Date().toISOString(), `periodic-sync:${row.id}:${bucket}`);
      }
    }
  }

  private async pollLive(): Promise<void> {
    if (!this.running) return;
    const candidates = getDb().prepare(`SELECT s.id,s.room_id,s.resolved_room_id,s.room_mapping_status,s.bili_uid,s.live_poll_seconds,ls.checked_at
      FROM streamers s LEFT JOIN live_state ls ON ls.streamer_id=s.id WHERE s.enabled=1 ORDER BY s.id`).all() as Row[];
    const timestamp = Date.now();
    const rows = candidates.filter((row) => !row.checked_at ||
      timestamp - new Date(String(row.checked_at)).getTime() >= Number(row.live_poll_seconds) * 1000);
    if (rows.length === 0) return;
    const cookie = getSecret('bilibili_cookie');
    try {
      let client = createBilibiliClient(cookie);
      let states;
      try {
        states = await client.fetchLiveStates(rows.map((row) => ({ roomId: pollRoomId(row), biliUid: String(row.bili_uid) })));
      } catch (error) {
        if (!cookie || !isInvalidCookie(error)) throw error;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '直播状态抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = createBilibiliClient(null);
          states = await client.fetchLiveStates(rows.map((row) => ({ roomId: pollRoomId(row), biliUid: String(row.bili_uid) })));
      }
      for (const row of rows) {
        const state = states.get(pollRoomId(row));
        if (state) {
          updateRoomMapping(String(row.id), { resolvedRoomId: state.resolvedRoomId, shortRoomId: state.shortRoomId,
            uid: state.uid, expectedUid: String(row.bili_uid) });
          if (!state.uid || state.uid === String(row.bili_uid)) updateLiveState(String(row.id), state.status, state.title);
        }
      }
    } catch (error) {
      upsertAlert('bilibili-live-poll', 'warning', '直播状态抓取失败', formatError(error));
    }
  }

  private async work(): Promise<void> {
    if (!this.running || this.workerActive) return;
    if (!acquireServiceLease('scheduler-worker', 30_000, this.workerLeaseOwner)) return;
    this.workerActive = true;
    const heartbeat = setInterval(() => {
      if (this.running) acquireServiceLease('scheduler-worker', 30_000, this.workerLeaseOwner);
    }, 10_000);
    heartbeat.unref();
    try {
      while (this.running) {
        if (!acquireServiceLease('scheduler-worker', 30_000, this.workerLeaseOwner)) break;
        const job = leaseNextJob();
        if (!job) break;
        try {
          await this.execute(job);
          finishJob(String(job.id));
        } catch (error) {
          if (isPermanentPiResultError(error)) {
            // Structured model output is deterministic; retrying it only burns tokens.
            finishJob(String(job.id));
            upsertAlert(`job-permanent:${job.type}:${job.entity_id}`, 'warning', `Pi 结果需要降级处理：${job.type}`, formatError(error));
            continue;
          }
          const delay = backoffDelay(Number(job.attempts), error);
          failJob(String(job.id), error, delay);
          if (Number(job.attempts) >= 3 && String(job.type) !== 'send_alert_email') {
            upsertAlert(`job:${job.type}:${job.entity_id}`, 'warning', `任务连续失败：${job.type}`, formatError(error));
          }
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.workerActive = false;
      releaseServiceLease('scheduler-worker', this.workerLeaseOwner);
    }
  }

  private async execute(job: Row): Promise<void> {
    const payload = safeJson(String(job.payload_json ?? '{}'));
    switch (job.type) {
      case 'sync_streamer': return this.syncStreamer(String(job.entity_id), payload);
      case 'refresh_dynamic': return this.refreshDynamic(String(job.entity_id));
      case 'sync_comments': return this.syncComments(String(job.entity_id), payload);
      case 'sync_sub_replies': return this.syncSubReplies(payload);
      case 'download_media': return downloadMediaAsset(String(job.entity_id));
      case 'pi_analyze': return analyzeStreamerWithPi(String(job.entity_id), { ...payload, attemptNumber: Number(job.attempts) });
      case 'pi_revision': return analyzeDynamicRevisionWithPi(String(job.entity_id), Number(job.attempts));
      case 'recognize_schedule': return recognizeScheduleDraftWithPi(String(job.entity_id));
      case 'repair_dynamic_archives': return this.repairDynamicArchives();
      case 'cleanup_storage': await cleanupStorage(); return;
      case 'send_alert_email': return sendAlertEmail(String(job.entity_id));
      case 'validate_cookie': return this.validateCookie();
      default: throw new Error(`未知任务类型：${job.type}`);
    }
  }

  private async validateCookie(): Promise<void> {
    const cookie = getSecret('bilibili_cookie');
    if (!cookie) return;
    try {
      const result = await createBilibiliClient(cookie).validateCookie();
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
    const scanId = String(payload.scanId ?? randomUUID());
    const initializing = !streamer.dynamic_history_initialized_at;
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    const cookie = getSecret('bilibili_cookie');
    let client = createBilibiliClient(cookie);
    let feed;
    try {
      feed = await client.fetchSpaceDynamics(String(streamer.bili_uid), (initializing || fullSync) ? 1000 : 30, (initializing || fullSync) ? since.toISOString() : undefined);
    } catch (error) {
      if (cookie && isInvalidCookie(error)) {
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '已自动回退到匿名抓取，请尽快在后台更新 Cookie。');
        client = createBilibiliClient(null);
        feed = await client.fetchSpaceDynamics(String(streamer.bili_uid), (initializing || fullSync) ? 1000 : 30, (initializing || fullSync) ? since.toISOString() : undefined);
      } else {
        if (error instanceof BilibiliError && (error.status === 412 || error.code === 412)) {
          upsertAlert('bilibili-dynamic-rate-limited', 'warning', cookie ? '动态请求被 B站 风控拦截' : '动态抓取需要 B站 Cookie',
            cookie ? 'B站返回 HTTP 412，请等待冷却后重试。' : '匿名动态接口返回 HTTP 412，请在后台配置当前有效的 B站 Cookie。');
        }
        throw error;
      }
    }
    resolveAlert('bilibili-dynamic-rate-limited', 'scheduler');
    const dynamics = feed.items;
    const newDynamicIds: string[] = [];
    const revisionIds: Array<{ revisionId: string; dynamicId: string }> = [];
    let detailBudget = (initializing || fullSync) ? Number.POSITIVE_INFINITY : 20;
    let detailsFetched = 0;
    for (const dynamic of dynamics) {
      const existing = getDynamic(dynamic.id);
      let enriched = dynamic;
      const feedLooksChanged = Boolean(existing && (dynamic.text !== existing.text ||
        JSON.stringify([...(dynamic.mediaUrls ?? [])].sort()) !== JSON.stringify(existing.media.map((item) => item.sourceUrl).sort())));
      if (detailBudget > 0 && (feedLooksChanged || dynamic.detailRequired ||
        (!String(dynamic.text ?? '').trim() && !hasRenderableDynamicCard(dynamic.rawExcerpt)) ||
        Boolean(existing && String(existing.text ?? '').includes('[') && Object.keys(existing.emojiMap ?? {}).length === 0))) {
        try {
          // 添加延迟以避免触发B站风控（第一个请求不延迟）
          if (detailsFetched > 0) {
            await delay(2000 + Math.floor(Math.random() * 1000)); // 2-3秒随机延迟
          }
          const detail = await client.fetchDynamicDetail(dynamic.id);
          enriched = { ...dynamic, text: detail.text || dynamic.text,
            mediaUrls: [...new Set([...(dynamic.mediaUrls ?? []), ...(detail.mediaUrls ?? [])])],
            emojiMap: { ...(dynamic.emojiMap ?? {}), ...(detail.emojiMap ?? {}) }, commentOid: detail.commentOid ?? dynamic.commentOid,
            commentType: detail.commentType ?? dynamic.commentType,
            editedAt: detail.editedAt, contentQuality: 'detail', detailFetchedAt: new Date().toISOString() };
          detailsFetched += 1;
        } catch (error) {
          // 只在非412错误时创建告警，避免告警泛滥
          if (!(error instanceof BilibiliError && (error.code === -412 || error.status === 412))) {
            upsertAlert(`dynamic-detail:${streamerId}`, 'info', '动态详情解析失败',
              `主播 ${String(streamer.name)} 的动态 ${dynamic.id}：${formatError(error)}`);
          }
          if (existing) {
            const archived = (existing.text.trim() || existing.media.length > 0 || Object.keys(existing.emojiMap ?? {}).length > 0)
              ? { text: existing.text, mediaUrls: existing.media.map((item) => item.sourceUrl), emojiMap: existing.emojiMap ?? {} }
              : getLatestCompleteDynamicSnapshot(dynamic.id);
            if (archived) enriched = { ...dynamic, text: archived.text || dynamic.text,
              mediaUrls: [...new Set([...(dynamic.mediaUrls ?? []), ...archived.mediaUrls])],
              emojiMap: { ...archived.emojiMap, ...(dynamic.emojiMap ?? {}) }, contentQuality: 'restored' };
          }
        }
        detailBudget -= 1;
      } else if (existing && (feedLooksChanged || !String(dynamic.text ?? '').trim())) {
        const archived = (existing.text.trim() || existing.media.length > 0 || Object.keys(existing.emojiMap ?? {}).length > 0)
          ? { text: existing.text, mediaUrls: existing.media.map((item) => item.sourceUrl), emojiMap: existing.emojiMap ?? {} }
          : getLatestCompleteDynamicSnapshot(dynamic.id);
        if (archived) enriched = { ...dynamic, text: archived.text || dynamic.text,
          mediaUrls: [...new Set([...(dynamic.mediaUrls ?? []), ...archived.mediaUrls])],
          emojiMap: { ...archived.emojiMap, ...(dynamic.emojiMap ?? {}) }, contentQuality: 'restored' };
      }
      const stored = upsertDynamic({ ...enriched, streamerId, contentQuality: enriched.contentQuality ?? 'feed' });
      if (stored.created) newDynamicIds.push(dynamic.id);
      else if (stored.changed && stored.revisionId) revisionIds.push({ revisionId: stored.revisionId, dynamicId: dynamic.id });
      if (dynamic.avatarUrl) getDb().prepare('UPDATE streamers SET avatar_url=COALESCE(avatar_url,?),updated_at=? WHERE id=?').run(dynamic.avatarUrl, new Date().toISOString(), streamerId);
    }
    if ((initializing || fullSync) && feed.complete) {
      markMissingDynamicsDeleted(streamerId, dynamics.map((item) => item.id), since.toISOString(), scanId);
    }
    if ((initializing || fullSync) && feed.complete) getDb().prepare('UPDATE streamers SET dynamic_history_initialized_at=COALESCE(dynamic_history_initialized_at,?),last_dynamic_full_sync_at=?,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), streamerId);
    getDb().prepare('UPDATE streamers SET last_dynamic_sync_at=?,updated_at=? WHERE id=?')
      .run(new Date().toISOString(), new Date().toISOString(), streamerId);
    stagePiDynamicIds(streamerId, newDynamicIds);
    const completedRequestedRange = !(initializing || fullSync) || feed.complete;
    if (completedRequestedRange) {
      queuePiDynamicBatch(streamerId, newDynamicIds, initializing, initializing ? 0 : 30_000);
      for (const revision of revisionIds) queuePiRevisionAnalysis(revision.revisionId, revision.dynamicId, 30_000);
    }
  }

  private async syncComments(dynamicId: string, payload: Row = {}): Promise<void> {
    const dynamic = getDb().prepare(`SELECT d.*,s.bili_uid FROM dynamics d JOIN streamers s ON s.id=d.streamer_id WHERE d.id=?`)
      .get(dynamicId) as Row | undefined;
    if (!dynamic) return;
    const state = getDb().prepare('SELECT * FROM comment_sync_state WHERE dynamic_id=?').get(dynamicId) as Row | undefined;
    const cookie = getSecret('bilibili_cookie');
    let client = createBilibiliClient(cookie);
    let anonymousFallback = false;
    const callWithCookieFallback = async <T>(operation: (activeClient: BilibiliClient) => Promise<T>): Promise<T> => {
      try { return await operation(client); }
      catch (error) {
        if (!cookie || anonymousFallback || !isInvalidCookie(error)) throw error;
        anonymousFallback = true;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '评论抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = createBilibiliClient(null);
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
    const fullScan = payload.fullScan === true || (!offset && !Array.isArray(payload.seenRootIds));
    const seenRootIds = Array.isArray(payload.seenRootIds) ? payload.seenRootIds.map(String) : [];
    const scanId = String(payload.scanId ?? Date.now());
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
            streamerUid: String(dynamic.bili_uid), scanId }, 60, new Date().toISOString(), `sub:${dynamicId}:${rootId}:${scanId}:1`);
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
    if (complete && fullScan) markMissingRootCommentsUnavailable(dynamicId, [...new Set(seenRootIds)]);
    getDb().prepare('UPDATE streamers SET last_comment_sync_at=? WHERE id=?').run(new Date().toISOString(), dynamic.streamer_id);
    if (!complete) enqueueJob('sync_comments', dynamicId, { fullScan, seenRootIds: [...new Set(seenRootIds)], scanId }, 55,
      new Date(Date.now() + 5000).toISOString(), `comments:${dynamicId}:continue:${offset}`);
    else enqueueJob('sync_comments', dynamicId, {}, 90, nextSyncAt, `comments:${dynamicId}:next:${nextSyncAt}`);
  }

  private async syncSubReplies(payload: Row): Promise<void> {
    const dynamicId = String(payload.dynamicId ?? '');
    if (!dynamicId || !getDynamic(dynamicId)) return;
    const cookie = getSecret('bilibili_cookie');
    let client = createBilibiliClient(cookie);
    let anonymousFallback = false;
    const callWithCookieFallback = async <T>(operation: (activeClient: BilibiliClient) => Promise<T>): Promise<T> => {
      try { return await operation(client); }
      catch (error) {
        if (!cookie || anonymousFallback || !isInvalidCookie(error)) throw error;
        anonymousFallback = true;
        upsertAlert('bilibili-cookie-invalid', 'critical', 'B站 Cookie 已失效', '楼中楼抓取已自动回退到匿名模式，请尽快更新 Cookie。');
        client = createBilibiliClient(null);
        return operation(client);
      }
    };
    const start = Number(payload.startPage ?? 1);
    const end = Math.min(Number(payload.totalPages ?? start), start + 9);
    const fullScan = payload.fullScan === true || (start === 1 && !Array.isArray(payload.seenIds));
    const seenIds = Array.isArray(payload.seenIds) ? payload.seenIds.map(String) : [];
    for (let page = start; page <= end; page += 1) {
      if (page > start) await delay(config.commentPageDelayMs + Math.floor(Math.random() * 500));
      const comments = await callWithCookieFallback((activeClient) => activeClient.fetchSubReplies(String(payload.oid), String(payload.type), String(payload.rootId), page));
      for (const comment of comments) {
        upsertComment({ ...comment, dynamicId, isStreamer: comment.authorUid === String(payload.streamerUid) });
        seenIds.push(comment.id);
      }
    }
    if (end < Number(payload.totalPages)) {
      const next = end + 1;
      enqueueJob('sync_sub_replies', dynamicId, { ...payload, startPage: next, fullScan, seenIds: [...new Set(seenIds)] }, 65,
        new Date(Date.now() + 5000).toISOString(), `sub:${dynamicId}:${payload.rootId}:${payload.scanId}:${next}`);
    } else if (fullScan) {
      markMissingRepliesUnavailable(dynamicId, String(payload.rootId), [...new Set(seenIds)]);
    }
  }

  private async refreshDynamic(dynamicId: string): Promise<void> {
    const row = getDb().prepare(`SELECT d.streamer_id,d.published_at,s.bili_uid FROM dynamics d
      JOIN streamers s ON s.id=d.streamer_id WHERE d.id=?`).get(dynamicId) as Row | undefined;
    if (!row) return;
    const cookie = getSecret('bilibili_cookie');
    const client = createBilibiliClient(cookie);
    let feedDynamic: Awaited<ReturnType<BilibiliClient['fetchSpaceDynamics']>>['items'][number] | null = null;
    try {
      const cutoff = new Date(new Date(String(row.published_at)).getTime() - 1000).toISOString();
      const feed = await client.fetchSpaceDynamics(String(row.bili_uid), 1000, cutoff);
      feedDynamic = feed.items.find((item) => item.id === dynamicId) ?? null;
    } catch {
      // The detail endpoint remains an independent fallback when the space feed is rate limited.
    }
    try {
      const detail = await client.fetchDynamicDetail(dynamicId);
      const current = getDb().prepare('SELECT * FROM dynamics WHERE id=?').get(dynamicId) as Row;
      const stored = upsertDynamic({ ...(feedDynamic ?? {}), id: dynamicId, streamerId: String(row.streamer_id), type: feedDynamic?.type ?? String(current.type),
        text: detail.text || feedDynamic?.text || '', sourceUrl: feedDynamic?.sourceUrl ?? String(current.source_url),
        publishedAt: feedDynamic?.publishedAt ?? String(current.published_at), commentOid: detail.commentOid ?? feedDynamic?.commentOid,
        commentType: detail.commentType ?? feedDynamic?.commentType, commentCount: feedDynamic?.commentCount ?? Number(current.comment_count),
        likeCount: feedDynamic?.likeCount ?? Number(current.like_count),
        mediaUrls: [...new Set([...(feedDynamic?.mediaUrls ?? []), ...(detail.mediaUrls ?? [])])],
        emojiMap: { ...(feedDynamic?.emojiMap ?? {}), ...detail.emojiMap },
        rawExcerpt: feedDynamic?.rawExcerpt, editedAt: detail.editedAt, contentQuality: 'detail', detailFetchedAt: new Date().toISOString() });
      if (stored.changed && stored.revisionId) queuePiRevisionAnalysis(stored.revisionId, dynamicId, 0);
    } catch (error) {
      if (feedDynamic) {
        const stored = upsertDynamic({ ...feedDynamic, streamerId: String(row.streamer_id), contentQuality: 'feed' });
        if (stored.changed && stored.revisionId) queuePiRevisionAnalysis(stored.revisionId, dynamicId, 0);
        return;
      }
      if (error instanceof BilibiliError && [404, 410].includes(Number(error.status))) {
        const current = getDb().prepare('SELECT * FROM dynamics WHERE id=?').get(dynamicId) as Row;
        const archived = getLatestCompleteDynamicSnapshot(dynamicId);
        if (archived && !String(current.text ?? '').trim()) {
          upsertDynamic({ id: dynamicId, streamerId: String(row.streamer_id), type: String(current.type), text: archived.text,
            sourceUrl: String(current.source_url), publishedAt: String(current.published_at), commentOid: String(current.comment_oid ?? '') || null,
            commentType: String(current.comment_type ?? '') || null, commentCount: Number(current.comment_count), likeCount: Number(current.like_count),
            mediaUrls: archived.mediaUrls, emojiMap: archived.emojiMap, contentQuality: 'restored' });
        }
        markDynamicDeleted(dynamicId);
      }
      else throw error;
    }
  }

  private async repairDynamicArchives(): Promise<void> {
    const rows = getDb().prepare(`SELECT d.id FROM dynamics d WHERE trim(d.text)='' AND EXISTS(
      SELECT 1 FROM dynamic_revisions dr WHERE dr.dynamic_id=d.id AND trim(dr.text)!='') ORDER BY d.updated_at LIMIT 10`).all() as Row[];
    for (const [index, row] of rows.entries()) {
      if (index > 0) await delay(1500);
      try { await this.refreshDynamic(String(row.id)); }
      catch (error) {
        if (error instanceof BilibiliError && (error.status === 412 || error.code === 412 || error.code === 429)) throw error;
      }
    }
    if (rows.length === 10) enqueueJob('repair_dynamic_archives', null, {}, 70,
      new Date(Date.now() + 60_000).toISOString(), `repair-dynamics:${Date.now()}`);
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
  if (error instanceof Error && error.name === 'PiLeaseBusyError') return 30_000;
  if (error instanceof Error && error.name === 'PiRevisionMediaPendingError') return 15_000;
  if (error instanceof Error && /\b(429|503)\b|rate.?limit|No available accounts/i.test(error.message)) return Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempt - 1, 6));
  return Math.min(60 * 60_000, Math.max(5000, 2 ** Math.min(attempt, 10) * 1000));
}

function isPermanentPiResultError(error: unknown): boolean {
  const message = formatError(error);
  return /预测时间必须是未来时间|编辑分析试图停用不属于该动态的事件|非取消编辑事件必须包含时间|模型未提交结构化动态编辑分析/i.test(message)
    || /^400 \{"model":"deepseek-v4-flash-vision-exp"\}/i.test(message);
}

function isInvalidCookie(error: unknown): boolean {
  return error instanceof BilibiliError && (error.code === -101 || error.code === -352);
}

function pollRoomId(row: Row): string {
  return row.room_mapping_status === 'verified' && row.resolved_room_id ? String(row.resolved_room_id) : String(row.room_id);
}

function hasRenderableDynamicCard(rawExcerpt: string | null | undefined): boolean {
  return Boolean(safeJson(String(rawExcerpt ?? '{}')).card);
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(value: string): Row { try { return JSON.parse(value) as Row; } catch { return {}; } }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
