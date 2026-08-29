import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BilibiliClient, extractInitialState, normalizeComment, normalizeDynamic, resolveRoomRecord } from './bilibili';
import { closeDb, getDb } from './db';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './security';
import { richTextHtml } from '$lib/format';
import { recognizeScheduleDraftWithPi } from './pi';
import { downloadMediaAsset } from './media';
import {
  confirmScheduleDraft, createManualScheduleDraft, createStreamer, decodeArchiveCursor, enqueueJob, getPredictionEvaluationSummary,
  failScheduleDraftRecognition, getScheduleDraft, getSecret, leaseNextJob, listComments, listCommentsPage, listDynamicRevisions, listDynamics, listDynamicsPage,
  markMissingDynamicsDeleted, markMissingRootCommentsUnavailable, putSecret, rollOverdueForecasts, setForecast, updateLiveState,
  saveScheduleDraftRecognition, updateRoomMapping, updateScheduleDraftEntries, upsertComment, upsertDynamic, upsertTimelineEvent
} from './store';

afterAll(() => closeDb());

describe('Bilibili normalization', () => {
  it('extracts initial state without being confused by braces in strings', () => {
    const state = extractInitialState('<script>window.__INITIAL_STATE__ = {"detail":{"text":"a } \\\" b"}};</script>');
    expect(state.detail.text).toBe('a } " b');
  });

  it('normalizes dynamics and nested comments', () => {
    const dynamic = normalizeDynamic({ id_str: '123', type: 'DYNAMIC_TYPE_WORD', modules: {
      module_author: { pub_ts: 1700000000 }, module_dynamic: { desc: { text: '今晚 20:00 开播' }, major: null },
      module_stat: { comment: { count: 2 }, like: { count: 3 } }
    } }, '42');
    expect(dynamic).toMatchObject({ id: '123', text: '今晚 20:00 开播', commentCount: 2 });
    const comment = normalizeComment({ rpid_str: '9', member: { mid: '42', uname: '主播', avatar: 'a' },
      content: { message: '晚点播' }, ctime: 1700000000, like: 5, parent: 8 }, '7');
    expect(comment).toMatchObject({ id: '9', rootId: '7', parentId: '8', message: '晚点播' });
  });

  it('normalizes Bilibili image URLs and proxies inline emoji', () => {
    const dynamic = normalizeDynamic({ id_str: '124', modules: {
      module_author: { pub_ts: 1700000000, face: '//i2.hdslb.com/face.jpg' },
      module_dynamic: { desc: { text: '[测试]' }, major: { draw: { items: [{ src: 'http://i1.hdslb.com/image.png' }] } } }
    } }, '42');
    expect(dynamic.avatarUrl).toBe('https://i2.hdslb.com/face.jpg');
    expect(dynamic.mediaUrls).toEqual(['https://i1.hdslb.com/image.png']);
    expect(richTextHtml('[测试]', { '[测试]': 'https://i0.hdslb.com/emoji.png' }))
      .toContain('src="/api/image-proxy/i0.hdslb.com/emoji.png"');
  });

  it('parses sanitized fixtures for common dynamic types', () => {
    const fixtures = JSON.parse(readFileSync(new URL('../../../tests/fixtures/bilibili/dynamic-types.json', import.meta.url), 'utf8')) as Record<string, any>;
    expect(normalizeDynamic(fixtures.word, '42')).toMatchObject({ id: 'fixture-word', text: '今晚 20:00 开播' });
    expect(normalizeDynamic(fixtures.draw, '42').mediaUrls).toEqual(['https://i0.hdslb.com/bfs/new_dyn/schedule.png']);
    expect(normalizeDynamic(fixtures.video, '42').mediaUrls).toEqual(['https://i1.hdslb.com/bfs/archive/cover.jpg']);
    expect(normalizeDynamic(fixtures.forward, '42')).toMatchObject({ type: 'DYNAMIC_TYPE_FORWARD', text: '转发一下' });
    expect(normalizeDynamic(fixtures.poll, '42')).toMatchObject({ type: 'DYNAMIC_TYPE_COMMON_SQUARE', text: '投票动态' });
  });

  it('marks a dynamic feed complete only after passing the cutoff', async () => {
    const page = (items: Array<{ id_str: string; pub_ts: number }>, hasMore: boolean, offset: string) => ({
      code: 0, data: { items, has_more: hasMore, offset }
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id_str: 'new', pub_ts: 1735689600 }, { id_str: 'pinned-old', pub_ts: 1609459200 }
      ], true, 'page-2')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id_str: 'older', pub_ts: 1609459200 }
      ], false, '')), { status: 200 }));
    try {
      const result = await new BilibiliClient().fetchSpaceDynamics('42', 10, '2024-01-01T00:00:00.000Z');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ complete: true, items: [{ id: 'new' }] });
    } finally { fetchMock.mockRestore(); }
  });

  it('resolves Bilibili short room ids', () => {
    expect(resolveRoomRecord({ '80397': { room_id: 80397, short_id: 510 } }, '510')).toMatchObject({ room_id: 80397 });
    expect(resolveRoomRecord({ '80397': { room_id: 80397, short_id: 0 } }, '0')).toBeUndefined();
    expect(resolveRoomRecord({
      '80397': { room_id: 80397, short_id: 510, uid: 7706705 },
      '90001': { room_id: 90001, short_id: 510, uid: 9000001 }
    }, '510', '7706705')).toMatchObject({ room_id: 80397 });
    expect(resolveRoomRecord({ '80397': { room_id: 80397, short_id: 510, uid: 7706705 } }, '510', '9000001')).toBeUndefined();
  });

  it('uses UID results when Bilibili keys a short room by its real room id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: {
        by_uids: { '7706705': { room_id: 80397, short_id: 510, uid: 7706705, live_status: 1, title: '看比赛咯' } },
        by_room_ids: {}
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const states = await new BilibiliClient().fetchLiveStates([
        { roomId: '510', biliUid: '7706705' },
        { roomId: '999', biliUid: '7706705' }
      ]);
      expect(states.get('510')).toMatchObject({ status: 'live', title: '看比赛咯', uid: '7706705',
        resolvedRoomId: '80397', shortRoomId: '510' });
      expect(states.get('999')).toMatchObject({ status: 'unknown' });
      const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(request.searchParams.getAll('room_ids')).toEqual(['510', '999']);
      expect(request.searchParams.getAll('uids')).toEqual(['7706705']);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('security and persistence', () => {
  it('hashes passwords and encrypts secrets', async () => {
    const hash = await hashPassword('long-test-password');
    expect(await verifyPassword('long-test-password', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
    const encrypted = encryptSecret('sensitive');
    expect(encrypted).not.toContain('sensitive');
    expect(decryptSecret(encrypted)).toBe('sensitive');
    putSecret('test', 'value');
    expect(getSecret('test')).toBe('value');
  });

  it('deduplicates jobs and leases the stored id', () => {
    const first = enqueueJob('test-job', null, { value: 1 }, 10, new Date().toISOString(), 'same-job');
    const second = enqueueJob('test-job', null, { value: 2 }, 10, new Date().toISOString(), 'same-job');
    expect(second).toBe(first);
    expect(String(leaseNextJob(['test-job'])?.id)).toBe(first);
    getDb().prepare("UPDATE jobs SET status='done' WHERE id=?").run(first);
    expect(enqueueJob('test-job', null, { value: 3 }, 10, new Date().toISOString(), 'same-job')).toBe(first);
    expect(leaseNextJob(['test-job'])).toBeNull();
    expect(getDb().prepare('SELECT status FROM jobs WHERE id=?').get(first)).toMatchObject({ status: 'done' });
  });

  it('releases expired running jobs after a process restart', () => {
    const id = enqueueJob('expired-job', null, {}, 10, new Date(Date.now() - 60_000).toISOString(), 'expired-running-job');
    getDb().prepare("UPDATE jobs SET status='running',lease_until=? WHERE id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), id);
    expect(String(leaseNextJob(['expired-job'])?.id)).toBe(id);
  });

  it('records revisions, comment hierarchy, and protects manual forecasts', () => {
    const streamerId = createStreamer({ slug: 'tester', name: '测试主播', biliUid: '10001', roomId: '20001' });
    const base = { id: 'dyn-1', streamerId, type: 'word', sourceUrl: 'https://example.invalid/1',
      publishedAt: new Date().toISOString(), text: '第一版' };
    expect(upsertDynamic(base).created).toBe(true);
    expect(upsertDynamic({ ...base, text: '第二版' }).changed).toBe(true);
    expect(listDynamics(streamerId)[0].text).toBe('第二版');
    expect(Number((getDb().prepare('SELECT COUNT(*) count FROM dynamic_revisions').get() as { count: number }).count)).toBe(1);
    upsertDynamic({ ...base, text: '带图片', mediaUrls: ['https://example.invalid/image.png'] });
    expect(listDynamics(streamerId)[0].media).toHaveLength(1);
    upsertDynamic({ ...base, text: '图片已移除', mediaUrls: [] });
    expect(listDynamics(streamerId)[0].media).toHaveLength(0);
    upsertComment({ id: 'c1', dynamicId: 'dyn-1', authorUid: '10001', authorName: '测试主播', message: '今晚晚点',
      isStreamer: true, publishedAt: new Date().toISOString(), mediaUrls: ['https://example.invalid/comment.png'] });
    expect(listComments('dyn-1')[0]).toMatchObject({ id: 'c1', isStreamer: true });
    expect(listComments('dyn-1')[0].media).toHaveLength(1);
    upsertComment({ id: 'c1', dynamicId: 'dyn-1', authorUid: '10001', authorName: '测试主播', message: '图片已移除',
      isStreamer: true, publishedAt: new Date().toISOString(), mediaUrls: [] });
    expect(listComments('dyn-1')[0].media).toHaveLength(0);
    markMissingRootCommentsUnavailable('dyn-1', []);
    expect(listComments('dyn-1')[0].state).toBe('unavailable');

    setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 3600_000).toISOString(), confidence: 100,
      source: 'manual', reason: '人工', evidence: [] }, 'test');
    expect(() => setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 7200_000).toISOString(), confidence: 80,
      source: 'pi', reason: 'AI', evidence: [] }, 'pi')).toThrow('人工预测已锁定');
  });

  it('confirms deletion only after two independent complete scans and restores visibility', () => {
    const streamerId = createStreamer({ slug: 'delete-test', name: '判删测试', biliUid: '10002', roomId: '20002' });
    const publishedAt = new Date().toISOString();
    upsertDynamic({ id: 'delete-dyn', streamerId, type: 'word', text: '仍然存在', sourceUrl: 'https://example.invalid/delete', publishedAt });
    markMissingDynamicsDeleted(streamerId, [], new Date(Date.now() - 3600_000).toISOString(), 'scan-one');
    expect(listDynamics(streamerId)[0].state).toBe('suspected_deleted');
    markMissingDynamicsDeleted(streamerId, [], new Date(Date.now() - 3600_000).toISOString(), 'scan-one');
    expect(listDynamics(streamerId)[0].state).toBe('suspected_deleted');
    markMissingDynamicsDeleted(streamerId, [], new Date(Date.now() - 3600_000).toISOString(), 'scan-two');
    expect(listDynamics(streamerId)[0].state).toBe('deleted');
    upsertDynamic({ id: 'delete-dyn', streamerId, type: 'word', text: '重新出现', sourceUrl: 'https://example.invalid/delete', publishedAt });
    expect(listDynamics(streamerId)[0].state).toBe('visible');
  });

  it('paginates equal timestamps with compound cursors and applies archive filters', () => {
    const streamerId = createStreamer({ slug: 'paging-test', name: '分页测试', biliUid: '10003', roomId: '20003' });
    const publishedAt = '2026-08-01T12:00:00.000Z';
    for (const id of ['page-c', 'page-b', 'page-a']) upsertDynamic({ id, streamerId, type: id === 'page-b' ? 'image' : 'word',
      text: id === 'page-a' ? '目标正文' : id, sourceUrl: `https://example.invalid/${id}`, publishedAt,
      mediaUrls: id === 'page-b' ? ['https://example.invalid/paging.png'] : [] });
    const first = listDynamicsPage(streamerId, 2);
    expect(first.items.map((item) => item.id)).toEqual(['page-c', 'page-b']);
    expect(decodeArchiveCursor(first.nextCursor)?.id).toBe('page-b');
    expect(listDynamicsPage(streamerId, 2, first.nextCursor ?? undefined).items.map((item) => item.id)).toEqual(['page-a']);
    expect(listDynamicsPage(streamerId, 30, undefined, { q: '目标', type: 'word' }).items.map((item) => item.id)).toEqual(['page-a']);
    expect(listDynamicsPage(streamerId, 30, undefined, { hasMedia: true }).items.map((item) => item.id)).toEqual(['page-b']);

    for (const id of ['comment-c', 'comment-b', 'comment-a']) upsertComment({ id, dynamicId: 'page-a', authorUid: id,
      authorName: id, message: id, publishedAt });
    const comments = listCommentsPage('page-a', 2);
    expect(comments.items.map((item) => item.id)).toEqual(['comment-c', 'comment-b']);
    expect(listCommentsPage('page-a', 2, comments.nextCursor ?? undefined).items.map((item) => item.id)).toEqual(['comment-a']);
  });

  it('persists room mappings and rejects UID conflicts', () => {
    const streamerId = createStreamer({ slug: 'room-test', name: '房间测试', biliUid: '7706705', roomId: '510' });
    updateRoomMapping(streamerId, { resolvedRoomId: '80397', shortRoomId: '510', uid: '7706705', expectedUid: '7706705' });
    expect(getDb().prepare('SELECT resolved_room_id,room_mapping_status FROM streamers WHERE id=?').get(streamerId))
      .toMatchObject({ resolved_room_id: '80397', room_mapping_status: 'verified' });
    updateRoomMapping(streamerId, { resolvedRoomId: '90001', shortRoomId: '510', uid: '9000001', expectedUid: '7706705' });
    expect(getDb().prepare('SELECT resolved_room_id,room_mapping_status FROM streamers WHERE id=?').get(streamerId))
      .toMatchObject({ resolved_room_id: '80397', room_mapping_status: 'conflict' });
  });

  it('creates, edits, and idempotently confirms schedule drafts', () => {
    const streamerId = createStreamer({ slug: 'schedule-test', name: '周表测试', biliUid: '10004', roomId: '20004' });
    upsertDynamic({ id: 'schedule-dyn', streamerId, type: 'draw', text: '本周直播周表', sourceUrl: 'https://example.invalid/schedule',
      publishedAt: new Date().toISOString(), mediaUrls: ['https://example.invalid/schedule.png'] });
    const draftId = createManualScheduleDraft('schedule-dyn');
    updateScheduleDraftEntries(draftId, [{ occurrenceDate: null, weekday: 3, localTime: '20:00', status: 'scheduled',
      title: '游戏', confidence: 91, sourceText: '周三 20:00 游戏' }]);
    expect(() => confirmScheduleDraft(draftId, null, 'test')).toThrow('周一日期');
    expect(confirmScheduleDraft(draftId, '2026-08-24', 'test')).toBe(1);
    expect(confirmScheduleDraft(draftId, '2026-08-24', 'test')).toBe(1);
    expect(getScheduleDraft(draftId)?.status).toBe('confirmed');
    expect(getDb().prepare("SELECT COUNT(*) count FROM schedule_exceptions WHERE source='schedule_confirmed'").get())
      .toMatchObject({ count: 1 });
  });

  it('does not let a queued recognizer overwrite an edited schedule draft', async () => {
    const streamerId = createStreamer({ slug: 'schedule-race', name: '周表竞态', biliUid: '10006', roomId: '20006' });
    upsertDynamic({ id: 'schedule-race-dyn', streamerId, type: 'draw', text: '直播安排',
      sourceUrl: 'https://example.invalid/schedule-race', publishedAt: new Date().toISOString(),
      mediaUrls: ['https://example.invalid/schedule-race.png'] });
    const draftId = createManualScheduleDraft('schedule-race-dyn');
    updateScheduleDraftEntries(draftId, [{ occurrenceDate: '2026-08-31', weekday: null, localTime: '19:00', status: 'scheduled',
      title: '人工草稿', confidence: 100, sourceText: '8月31日 19:00' }]);
    await recognizeScheduleDraftWithPi(draftId);
    expect(getScheduleDraft(draftId)).toMatchObject({ status: 'review', entries: [{ title: '人工草稿' }] });
  });

  it('does not let an in-flight recognizer overwrite an edited schedule draft', () => {
    const streamerId = createStreamer({ slug: 'schedule-inflight', name: '周表运行竞态', biliUid: '10009', roomId: '20009' });
    upsertDynamic({ id: 'schedule-inflight-dyn', streamerId, type: 'draw', text: '本周直播安排',
      sourceUrl: 'https://example.invalid/schedule-inflight', publishedAt: new Date().toISOString(),
      mediaUrls: ['https://example.invalid/schedule-inflight.png'] });
    const draftId = createManualScheduleDraft('schedule-inflight-dyn');
    getDb().prepare("UPDATE schedule_drafts SET status='processing' WHERE id=?").run(draftId);
    const manualEntries = [{ occurrenceDate: '2026-09-01', weekday: null, localTime: '21:00', status: 'scheduled' as const,
      title: '人工覆盖保护', confidence: 100, sourceText: '9月1日 21:00' }];
    updateScheduleDraftEntries(draftId, manualEntries);

    expect(saveScheduleDraftRecognition(draftId, { model: 'late-model', rawResult: {}, entries: [{ ...manualEntries[0], title: '模型迟到结果' }] })).toBe(false);
    expect(failScheduleDraftRecognition(draftId, '模型迟到失败')).toBe(false);
    expect(getScheduleDraft(draftId)).toMatchObject({ status: 'review', entries: [{ title: '人工覆盖保护' }], error: null });
  });

  it('keeps historical media available when equal files use different source URLs', async () => {
    const streamerId = createStreamer({ slug: 'media-alias', name: '媒体别名', biliUid: '10008', roomId: '20008' });
    const base = { id: 'media-alias-dyn', streamerId, type: 'draw', sourceUrl: 'https://example.invalid/dynamic',
      publishedAt: new Date().toISOString() };
    const firstUrl = 'https://example.invalid/first.gif';
    const secondUrl = 'https://example.invalid/second.gif';
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(bytes, {
      status: 200, headers: { 'content-type': 'image/gif', 'content-length': String(bytes.length) }
    }));
    try {
      upsertDynamic({ ...base, text: '第一版', mediaUrls: [firstUrl] });
      const firstMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get(base.id) as { media_id: string };
      await downloadMediaAsset(firstMedia.media_id);
      upsertDynamic({ ...base, text: '第二版', mediaUrls: [secondUrl] });
      const secondMedia = getDb().prepare('SELECT media_id FROM dynamic_media WHERE dynamic_id=?').get(base.id) as { media_id: string };
      await downloadMediaAsset(secondMedia.media_id);
      upsertDynamic({ ...base, text: '第三版', mediaUrls: [] });

      expect(getDb().prepare('SELECT media_id FROM media_source_aliases WHERE source_url=?').get(secondUrl))
        .toMatchObject({ media_id: firstMedia.media_id });
      const secondRevision = listDynamicRevisions(base.id).find((revision) => revision.text === '第二版');
      expect(secondRevision?.media[0]).toMatchObject({ sourceUrl: secondUrl, localUrl: `/media/${firstMedia.media_id}` });
    } finally { fetchMock.mockRestore(); }
  });

  it('enforces forecast priority, marks overdue predictions stale, and evaluates live starts', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-29T10:00:00.000Z');
    vi.setSystemTime(now);
    try {
      const streamerId = createStreamer({ slug: 'forecast-test', name: '预测测试', biliUid: '10005', roomId: '20005' });
      upsertDynamic({ id: 'forecast-evidence', streamerId, type: 'word', text: '今晚开播', sourceUrl: 'https://example.invalid/forecast', publishedAt: now.toISOString() });
      const eventId = upsertTimelineEvent({ streamerId, eventType: 'scheduled', plannedStartAt: '2026-08-29T12:00:00.000Z',
        sourceType: 'dynamic', sourceId: 'forecast-evidence', confidence: 90, title: '明确动态时间' });
      expect(eventId).toBeTruthy();
      expect(() => setForecast({ streamerId, predictedStartAt: '2026-08-29T13:00:00.000Z', confidence: 80, source: 'pi',
        reason: '较低优先级', evidence: [{ type: 'timeline_event', id: eventId }] }, 'test')).toThrow('更高优先级');
      vi.setSystemTime(new Date('2026-08-29T12:05:00.000Z'));
      updateLiveState(streamerId, 'live', '测试开播');
      expect(getPredictionEvaluationSummary(streamerId).count).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('expires an overdue manual forecast without permanently locking automation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T10:00:00.000Z'));
    try {
      const streamerId = createStreamer({ slug: 'manual-expiry', name: '人工过期', biliUid: '10007', roomId: '20007' });
      setForecast({ streamerId, predictedStartAt: '2026-08-29T11:00:00.000Z', confidence: 100, source: 'manual',
        reason: '人工预测', evidence: [] }, 'test');
      vi.setSystemTime(new Date('2026-08-29T11:01:00.000Z'));
      rollOverdueForecasts();
      expect(getDb().prepare('SELECT stale FROM forecasts WHERE streamer_id=? AND active=1').get(streamerId)).toMatchObject({ stale: 1 });
      expect(() => setForecast({ streamerId, predictedStartAt: '2026-08-29T12:00:00.000Z', confidence: 80, source: 'pi',
        reason: '新自动预测', evidence: [] }, 'test')).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
});
