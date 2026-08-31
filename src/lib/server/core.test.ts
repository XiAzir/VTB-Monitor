import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BilibiliClient, extractDynamicEditedAt, extractInitialState, isArchivedDynamicItem, isPinnedDynamicItem, normalizeComment, normalizeDynamic, resolveRoomRecord } from './bilibili';
import { closeDb, getDb } from './db';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './security';
import { richTextHtml } from '$lib/format';
import { buildStreamerAnalysisBatch, completeStreamerAnalysisBatch, createPiModel, recognizeScheduleDraftWithPi, revisionMediaChange } from './pi';
import { migrations } from './migrations';
import { downloadMediaAsset } from './media';
import { Scheduler } from './scheduler';
import {
  acquireServiceLease, confirmScheduleDraft, createManualScheduleDraft, createStreamer, decodeArchiveCursor, enqueueJob, getPredictionEvaluationSummary,
  failScheduleDraftRecognition, getDynamic, getScheduleDraft, getSecret, leaseNextJob, listComments, listCommentsPage, listDynamicRevisions, listDynamics, listDynamicsPage,
  listStreamerSummaries,
  markMissingDynamicsDeleted, markMissingRootCommentsUnavailable, putSecret, queuePiDynamicBatch, queuePiRevisionAnalysis, releaseServiceLease,
  rollOverdueForecasts, setForecast, stagePiDynamicIds, updateLiveState, saveScheduleDraftRecognition, updateRoomMapping, updateScheduleDraftEntries,
  upsertComment, upsertDynamic, upsertTimelineEvent
} from './store';

afterAll(() => closeDb());

describe('Bilibili normalization', () => {
  it('distinguishes native detail edit timestamps from publication timestamps', () => {
    expect(extractDynamicEditedAt({ modules: [{ module_author: {
      pub_ts: '1786371736', pub_time: '编辑于 2026年08月24日 18:30'
    } }] })).toBe('2026-08-24T10:30:00.000Z');
    expect(extractDynamicEditedAt({ modules: [{ module_author: {
      pub_ts: '1786371736', pub_time: '2026年08月10日 22:22'
    } }] })).toBeNull();
  });
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
    expect(normalizeDynamic(fixtures.opus, '42')).toMatchObject({ id: 'fixture-opus', text: '新版正文[新版表情]',
      mediaUrls: ['https://i0.hdslb.com/bfs/new_dyn/opus-image.png'],
      emojiMap: { '[新版表情]': 'https://i0.hdslb.com/bfs/garb/opus-emoji.png' } });
    expect(normalizeDynamic(fixtures.video, '42')).toMatchObject({
      mediaUrls: ['https://i1.hdslb.com/bfs/archive/cover.jpg'],
      rawExcerpt: expect.stringContaining('合作投稿视频')
    });
    const forward = normalizeDynamic(fixtures.forward, '42');
    expect(forward).toMatchObject({
      type: 'DYNAMIC_TYPE_FORWARD',
      text: '转发一下[外层表情]',
      emojiMap: { '[外层表情]': 'https://i0.hdslb.com/bfs/garb/outer.png' },
      mediaUrls: ['https://i0.hdslb.com/bfs/new_dyn/original.jpg']
    });
    expect(JSON.parse(String(forward.rawExcerpt)).card).toMatchObject({
      kind: 'forward', authorName: '原作者', text: '原动态[原文表情]',
      emojiMap: { '[原文表情]': 'https://i0.hdslb.com/bfs/garb/original.png' },
      sourceUrl: 'https://www.bilibili.com/opus/fixture-original'
    });
    expect(normalizeDynamic(fixtures.poll, '42')).toMatchObject({ type: 'DYNAMIC_TYPE_COMMON_SQUARE', text: '投票动态' });
    expect(isArchivedDynamicItem(fixtures.liveRecommendation)).toBe(false);
    expect(isArchivedDynamicItem({ ...fixtures.word, type: 'DYNAMIC_TYPE_WORD', modules: {
      ...fixtures.word.modules, module_dynamic: { major: { type: 'MAJOR_TYPE_LIVE_RCMD' } }
    } })).toBe(false);
  });

  it('stores structured video cards without archiving volatile counters', () => {
    const streamerId = createStreamer({ slug: `video-card-${Date.now()}`, name: '视频卡片测试', biliUid: '420042', roomId: '420042' });
    const base = { id: 'video-card-versioning', streamerId, type: 'DYNAMIC_TYPE_AV', text: '',
      sourceUrl: 'https://www.bilibili.com/opus/video-card-versioning', publishedAt: new Date().toISOString(),
      mediaUrls: ['https://example.invalid/video-cover.jpg'] };
    const raw = (title: string, viewCount: string) => JSON.stringify({ card: { kind: 'video', title, description: '简介',
      url: 'https://www.bilibili.com/video/BV1fixture', coverUrl: 'https://example.invalid/video-cover.jpg', durationText: '03:48',
      badge: '合作视频', viewCount, danmakuCount: '16' } });
    upsertDynamic({ ...base, rawExcerpt: raw('第一版标题', '2.2万') });
    expect(getDynamic(base.id)?.card).toMatchObject({ kind: 'video', title: '第一版标题', viewCount: '2.2万' });
    upsertDynamic({ ...base, rawExcerpt: raw('第一版标题', '2.3万') });
    expect(listDynamicRevisions(base.id)).toHaveLength(0);
    expect(getDynamic(base.id)?.card).toMatchObject({ kind: 'video', viewCount: '2.3万' });
    upsertDynamic({ ...base, rawExcerpt: raw('第二版标题', '2.3万') });
    expect(listDynamicRevisions(base.id)).toHaveLength(1);
  });

  it('marks a dynamic feed complete only after passing the cutoff', async () => {
    const page = (items: Array<{ id_str: string; pub_ts: number; modules?: Record<string, unknown> }>, hasMore: boolean, offset: string) => ({
      code: 0, data: { items, has_more: hasMore, offset }
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id_str: 'new', pub_ts: 1735689600 }, { id_str: 'pinned-old', pub_ts: 1609459200, modules: { module_tag: { text: '置顶' } } }
      ], true, 'page-2')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page([
        { id_str: 'older', pub_ts: 1609459200 }
      ], false, '')), { status: 200 }));
    try {
      const result = await new BilibiliClient().fetchSpaceDynamics('42', 10, '2024-01-01T00:00:00.000Z');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(request.searchParams.get('features')).toBe('itemOpusStyle');
      expect(result).toMatchObject({ complete: true, items: [{ id: 'new' }, { id: 'pinned-old', isPinned: true }] });
    } finally { fetchMock.mockRestore(); }
  });

  it('filters live recommendation cards without consuming the dynamic limit', async () => {
    const live = { id_str: 'live-card', type: 'DYNAMIC_TYPE_LIVE_RCMD', pub_ts: 1735689660, modules: {
      module_author: { pub_ts: 1735689660, pub_action: '直播了' },
      module_dynamic: { major: { type: 'MAJOR_TYPE_LIVE_RCMD' } }
    } };
    const actual = (id: string, timestamp: number) => ({ id_str: id, type: 'DYNAMIC_TYPE_WORD', modules: {
      module_author: { pub_ts: timestamp }, module_dynamic: { desc: { text: id }, major: null }
    } });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [live], has_more: true, offset: 'next' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [actual('real', 1735689600)], has_more: false, offset: '' } }), { status: 200 }));
    try {
      const result = await new BilibiliClient().fetchSpaceDynamics('42', 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ complete: true, items: [{ id: 'real', type: 'DYNAMIC_TYPE_WORD' }] });
    } finally { fetchMock.mockRestore(); }
  });

  it('recognizes the real Bilibili pinned tag instead of relying on is_top alone', () => {
    expect(isPinnedDynamicItem({ modules: { module_tag: { text: '置顶' }, module_author: { is_top: false } } })).toBe(true);
    expect(isPinnedDynamicItem({ modules: { module_author: { is_top: true } } })).toBe(true);
    expect(isPinnedDynamicItem({ modules: { module_author: { is_top: false } } })).toBe(false);
  });

  it('keeps completed dynamic pages when a later page is rate limited', async () => {
    const item = { id_str: 'partial-page', type: 'DYNAMIC_TYPE_WORD', modules: {
      module_author: { pub_ts: 1735689600 }, module_dynamic: { desc: { text: '已抓取正文' }, major: null }
    } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [item], has_more: true, offset: 'next' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 412 }));
    try {
      const result = await new BilibiliClient().fetchSpaceDynamics('42', 30);
      expect(result).toMatchObject({ complete: false, items: [{ id: 'partial-page', text: '已抓取正文' }] });
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

  it('resolves real and short room ids from UID live state results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      code: 0,
      data: { '7706705': { room_id: 80397, short_id: 510, uid: 7706705, live_status: 1, title: '看比赛咯' } }
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
      expect(request.searchParams.getAll('uids[]')).toEqual(['7706705']);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('falls back to room_init when UID batch results are missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {
        room_id: 1727076670, short_id: 0, uid: 1150976664, live_status: 0
      } }), { status: 200 }));
    try {
      const states = await new BilibiliClient().fetchLiveStates([{ roomId: '1727076670', biliUid: '1150976664' }]);
      expect(states.get('1727076670')).toMatchObject({ status: 'offline', uid: '1150976664',
        resolvedRoomId: '1727076670', shortRoomId: null });
      expect(new URL(String(fetchMock.mock.calls[1]?.[0])).pathname).toContain('/room_init');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('reports a room ownership conflict without adopting another streamer room', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {
        '7706705': { room_id: 80397, short_id: 510, uid: 7706705, live_status: 0 }
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: {
        room_id: 90001, short_id: 999, uid: 9000001, live_status: 1
      } }), { status: 200 }));
    try {
      const states = await new BilibiliClient().fetchLiveStates([{ roomId: '999', biliUid: '7706705' }]);
      expect(states.get('999')).toEqual({ status: 'unknown', title: null, uid: '9000001',
        resolvedRoomId: null, shortRoomId: null });
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe('security and persistence', () => {
  it('keeps explicit capabilities for custom Anthropic Pi models', () => {
    const { model } = createPiModel({ provider: 'anthropic', modelId: 'custom-vision-model',
      baseUrl: 'https://example.invalid', thinkingLevel: 'high', input: ['text', 'image'], output: ['text'], reasoning: true });
    expect(model).toMatchObject({ id: 'custom-vision-model', baseUrl: 'https://example.invalid',
      input: ['text', 'image'], reasoning: true });
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: false, supportsStrictTools: false, supportsToolReferences: false });
    const affinity = createPiModel({ provider: 'anthropic', modelId: 'custom-vision-model', baseUrl: 'https://example.invalid',
      input: ['text'], output: ['text'], sessionAffinity: true });
    expect(affinity.model.compat).toMatchObject({ sendSessionAffinityHeaders: true });
  });

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

  it('does not enqueue periodic or full sync while a streamer sync is active', () => {
    const streamerId = createStreamer({ slug: 'sync-dedupe', name: '同步合并', biliUid: '10109', roomId: '20109' });
    new Scheduler().enqueueDueDynamicSyncs();
    const active = getDb().prepare(`SELECT COUNT(*) count FROM jobs WHERE type='sync_streamer' AND entity_id=?
      AND status IN ('pending','retry','running')`).get(streamerId) as { count: number };
    expect(active.count).toBe(1);
  });

  it('prefers one full sync when periodic and daily sync are both due', () => {
    const streamerId = createStreamer({ slug: 'sync-priority', name: '同步优先级', biliUid: '10110', roomId: '20110' });
    getDb().prepare("UPDATE jobs SET status='done' WHERE type='sync_streamer' AND entity_id=?").run(streamerId);
    new Scheduler().enqueueDueDynamicSyncs();
    const active = getDb().prepare(`SELECT payload_json FROM jobs WHERE type='sync_streamer' AND entity_id=?
      AND status IN ('pending','retry','running')`).all(streamerId) as Array<{ payload_json: string }>;
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0].payload_json)).toEqual({ fullSync: true });
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
    expect(Number((getDb().prepare('SELECT COUNT(*) count FROM dynamic_revisions WHERE dynamic_id=?').get(base.id) as { count: number }).count)).toBe(1);
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

  it('does not present stale configuration errors as the current forecast reason', () => {
    const streamerId = createStreamer({ slug: 'forecast-reason', name: '预测理由', biliUid: '10010', roomId: '20010' });
    setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 60_000).toISOString(), confidence: 1, source: 'fallback',
      reason: 'Pi API Key 尚未配置，使用系统临时预测。', evidence: [] }, 'legacy');
    getDb().prepare('UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1').run(streamerId);
    expect(listStreamerSummaries().find((item) => item.id === streamerId)?.forecastReason).toContain('旧预测已过期');
    updateLiveState(streamerId, 'live', '正在播');
    expect(listStreamerSummaries().find((item) => item.id === streamerId)?.forecastReason).toBe('直播间状态已确认正在直播。');
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

  it('keeps every schedule image so recognition can process multiple batches', () => {
    const streamerId = createStreamer({ slug: 'schedule-images', name: '多图周表', biliUid: '10040', roomId: '20040' });
    const mediaUrls = Array.from({ length: 8 }, (_, index) => `https://example.invalid/schedule-${index + 1}.png`);
    upsertDynamic({ id: 'schedule-images-dyn', streamerId, type: 'draw', text: '本周直播周表',
      sourceUrl: 'https://example.invalid/schedule-images', publishedAt: new Date().toISOString(), mediaUrls });
    const draftId = createManualScheduleDraft('schedule-images-dyn');
    const row = getDb().prepare('SELECT media_urls_json FROM schedule_drafts WHERE id=?').get(draftId) as { media_urls_json: string };
    expect(JSON.parse(row.media_urls_json)).toEqual(mediaUrls);
  });

  it('does not treat reposted media as the streamers own schedule image', () => {
    const streamerId = createStreamer({ slug: 'schedule-forward', name: '转发周表', biliUid: '10041', roomId: '20041' });
    upsertDynamic({ id: 'schedule-forward-dyn', streamerId, type: 'DYNAMIC_TYPE_FORWARD', text: '提醒一下周表换了',
      sourceUrl: 'https://example.invalid/schedule-forward', publishedAt: new Date().toISOString(),
      mediaUrls: ['https://example.invalid/original-artwork.png'] });
    expect(getDb().prepare('SELECT id FROM schedule_drafts WHERE dynamic_id=?').get('schedule-forward-dyn')).toBeUndefined();
  });

  it('recognizes a pinned this-week surprise-stream post as a schedule candidate', () => {
    const streamerId = createStreamer({ slug: 'schedule-surprise', name: '突击周表', biliUid: '10042', roomId: '20042' });
    upsertDynamic({ id: 'schedule-surprise-dyn', streamerId, type: 'DYNAMIC_TYPE_DRAW', text: '这周突击会多点',
      sourceUrl: 'https://example.invalid/schedule-surprise', publishedAt: new Date().toISOString(),
      mediaUrls: ['https://example.invalid/weekly-schedule.png'], isPinned: true });
    expect(getDb().prepare('SELECT id FROM schedule_drafts WHERE dynamic_id=?').get('schedule-surprise-dyn')).toBeDefined();
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
      const equalContentRevision = listDynamicRevisions(base.id).find((revision) => revision.text === '第一版');
      expect(revisionMediaChange(equalContentRevision!, getDynamic(base.id)!)).toMatchObject({ pending: false, changed: false });
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

  it('selects only the latest 30 streamer-authored dynamics within 14 days', () => {
    const streamerId = createStreamer({ slug: 'pi-baseline', name: 'Pi 基线', biliUid: '10100', roomId: '20100' });
    const now = Date.now();
    for (let index = 0; index < 35; index += 1) {
      upsertDynamic({ id: `pi-base-${index.toString().padStart(2, '0')}`, streamerId, type: 'word', text: `本人内容 ${index}`,
        sourceUrl: `https://example.invalid/pi-base-${index}`, publishedAt: new Date(now - index * 60_000).toISOString() });
    }
    upsertDynamic({ id: 'pi-too-old', streamerId, type: 'word', text: '过期内容', sourceUrl: 'https://example.invalid/pi-old',
      publishedAt: new Date(now - 15 * 24 * 3600_000).toISOString() });
    upsertDynamic({ id: 'pi-pinned-old', streamerId, type: 'word', text: '很早以前的置顶内容', sourceUrl: 'https://example.invalid/pi-pinned-old',
      publishedAt: new Date(now - 120 * 24 * 3600_000).toISOString(), isPinned: true });
    const batch = buildStreamerAnalysisBatch(streamerId, { mode: 'baseline' });
    expect(batch.mode).toBe('baseline');
    expect(batch.dynamics).toHaveLength(30);
    expect(batch.dynamics.some((item) => item.id === 'pi-too-old')).toBe(false);
    expect(batch.dynamics[0]).toMatchObject({ id: 'pi-pinned-old', isPinned: true,
      lastEditedAtSource: 'published_fallback', lastEditedAt: new Date(now - 120 * 24 * 3600_000).toISOString() });
    expect(batch.dynamics.slice(1).map((item) => item.id)).toEqual(Array.from({ length: 29 }, (_, index) => `pi-base-${index.toString().padStart(2, '0')}`));
    const edited = upsertDynamic({ id: 'pi-base-00', streamerId, type: 'word', text: '本人内容已编辑',
      sourceUrl: 'https://example.invalid/pi-base-0', publishedAt: new Date(now).toISOString() });
    expect(edited.changed).toBe(true);
    expect(buildStreamerAnalysisBatch(streamerId, { mode: 'baseline' }).dynamics.find((item) => item.id === 'pi-base-00'))
      .toMatchObject({ lastEditedAtSource: 'observed_revision' });
  });

  it('keeps only streamer-authored card text and never queues Pi for comments', () => {
    const streamerId = createStreamer({ slug: 'pi-authored', name: 'Pi 原创', biliUid: '10101', roomId: '20101' });
    getDb().prepare('UPDATE pi_event_cursors SET baseline_completed_at=? WHERE streamer_id=?').run(new Date().toISOString(), streamerId);
    const forward = upsertDynamic({ id: 'pi-forward', streamerId, type: 'DYNAMIC_TYPE_FORWARD', text: '主播附言',
      sourceUrl: 'https://example.invalid/pi-forward', publishedAt: new Date().toISOString(),
      rawExcerpt: JSON.stringify({ card: { kind: 'forward', authorName: '原作者', authorUid: '9', authorAvatarUrl: null,
        text: '原动态今晚十点开播', emojiMap: {}, sourceUrl: null, originalType: 'word', mediaUrls: [], video: null, unavailable: false } }) });
    const silentForward = upsertDynamic({ id: 'pi-forward-silent', streamerId, type: 'DYNAMIC_TYPE_FORWARD', text: '',
      sourceUrl: 'https://example.invalid/pi-forward-silent', publishedAt: new Date(Date.now() + 1000).toISOString(),
      rawExcerpt: JSON.stringify({ card: { kind: 'forward', authorName: '原作者', authorUid: '9', authorAvatarUrl: null,
        text: '原动态明天开播', emojiMap: {}, sourceUrl: null, originalType: 'word', mediaUrls: [], video: null, unavailable: false } }) });
    stagePiDynamicIds(streamerId, ['pi-forward', 'pi-forward-silent']);
    const beforeJobs = Number((getDb().prepare("SELECT COUNT(*) count FROM jobs WHERE type='pi_analyze'").get() as { count: number }).count);
    upsertComment({ id: 'pi-comment', dynamicId: 'pi-forward', authorUid: '10101', authorName: '主播', message: '评论区说今晚播',
      isStreamer: true, publishedAt: new Date().toISOString() });
    expect(Number((getDb().prepare("SELECT COUNT(*) count FROM jobs WHERE type='pi_analyze'").get() as { count: number }).count)).toBe(beforeJobs);
    const batch = buildStreamerAnalysisBatch(streamerId, { mode: 'incremental' });
    expect(batch.dynamics).toMatchObject([{ id: 'pi-forward', text: '主播附言' }]);
    expect(batch.dynamics[0]?.text).not.toContain('原动态');
    expect(batch.processedDynamicIds).toEqual(['pi-forward', 'pi-forward-silent']);
    completeStreamerAnalysisBatch(streamerId, batch);
    expect(getDb().prepare('SELECT COUNT(*) count FROM pi_pending_dynamics WHERE streamer_id=?').get(streamerId)).toMatchObject({ count: 0 });
    expect(forward.created && silentForward.created).toBe(true);
  });

  it('coalesces new dynamics, continues batches over 30, and queues every substantive revision', () => {
    const streamerId = createStreamer({ slug: 'pi-batches', name: 'Pi 合批', biliUid: '10102', roomId: '20102' });
    getDb().prepare('UPDATE pi_event_cursors SET baseline_completed_at=? WHERE streamer_id=?').run(new Date().toISOString(), streamerId);
    const ids: string[] = [];
    for (let index = 0; index < 35; index += 1) {
      const id = `pi-pending-${index.toString().padStart(2, '0')}`;
      ids.push(id);
      upsertDynamic({ id, streamerId, type: 'word', text: `新增 ${index}`, sourceUrl: `https://example.invalid/${id}`,
        publishedAt: new Date(Date.now() + index * 1000).toISOString() });
    }
    const firstJob = queuePiDynamicBatch(streamerId, ids.slice(0, 20), false, 0);
    expect(queuePiDynamicBatch(streamerId, ids.slice(20), false, 0)).toBe(firstJob);
    expect(getDb().prepare("SELECT COUNT(*) count FROM jobs WHERE type='pi_analyze' AND entity_id=? AND status='pending'").get(streamerId))
      .toMatchObject({ count: 1 });
    const firstBatch = buildStreamerAnalysisBatch(streamerId, { mode: 'incremental' });
    expect(firstBatch.dynamics).toHaveLength(30);
    completeStreamerAnalysisBatch(streamerId, firstBatch);
    getDb().prepare("UPDATE jobs SET status='done' WHERE id=?").run(firstJob);
    expect(queuePiDynamicBatch(streamerId, [], false, 0)).toBeTruthy();
    expect(buildStreamerAnalysisBatch(streamerId, { mode: 'incremental' }).dynamics).toHaveLength(5);

    const original = upsertDynamic({ id: 'pi-never-analyzed', streamerId, type: 'word', text: '旧正文',
      sourceUrl: 'https://example.invalid/pi-never-analyzed', publishedAt: new Date().toISOString() });
    const edited = upsertDynamic({ id: 'pi-never-analyzed', streamerId, type: 'word', text: '新正文',
      sourceUrl: 'https://example.invalid/pi-never-analyzed', publishedAt: new Date().toISOString() });
    expect(original.created).toBe(true);
    expect(queuePiRevisionAnalysis(edited.revisionId!, 'pi-never-analyzed', 0)).toBeTruthy();
  });

  it('isolates service leases by scheduler instance owner', () => {
    const name = `worker-test-${Date.now()}`;
    expect(acquireServiceLease(name, 60_000, 'owner-a')).toBe(true);
    expect(acquireServiceLease(name, 60_000, 'owner-b')).toBe(false);
    expect(acquireServiceLease(name, 60_000, 'owner-a')).toBe(true);
    releaseServiceLease(name, 'owner-a');
    expect(acquireServiceLease(name, 60_000, 'owner-b')).toBe(true);
    releaseServiceLease(name, 'owner-b');
  });

  it('upgrades a version 8 database to the Pi batching schema', () => {
    const directory = join(tmpdir(), `vtb-monitor-migration-${Date.now()}`);
    const path = join(directory, 'upgrade.sqlite');
    mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path);
    try {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      for (const migration of migrations.filter((item) => item.version <= 8)) {
        db.exec(migration.sql);
        db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(migration.version, new Date().toISOString());
      }
      db.prepare(`INSERT INTO pi_conversations(id,streamer_id,kind,title,created_at,updated_at) VALUES ('legacy',NULL,'streamer','旧会话',?,?)`)
        .run(new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO jobs(id,type,entity_id,payload_json,priority,status,attempts,max_attempts,due_at,dedupe_key,created_at,updated_at)
        VALUES ('old-pi-job','pi_analyze',NULL,'{}',10,'pending',0,5,?,NULL,?,?)`)
        .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO streamers(id,slug,name,bili_uid,room_id,dynamic_url,live_url,created_at,updated_at)
        VALUES ('live-card-streamer','live-card-streamer','直播卡测试','90901','90902','https://example.invalid/dynamic','https://example.invalid/live',?,?)`)
        .run(new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO dynamics(id,streamer_id,type,text,source_url,published_at,updated_at,last_seen_at,content_hash)
        VALUES ('legacy-live-card','live-card-streamer','DYNAMIC_TYPE_LIVE_RCMD','','https://example.invalid/live-card',?,?,?,'hash')`)
        .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO jobs(id,type,entity_id,payload_json,priority,status,attempts,max_attempts,due_at,dedupe_key,created_at,updated_at)
        VALUES ('legacy-live-job','refresh_dynamic','legacy-live-card','{}',10,'pending',0,5,?,NULL,?,?)`)
        .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      for (const migration of migrations.filter((item) => item.version > 8)) db.exec(migration.sql);
      expect((db.prepare('PRAGMA table_info(ai_usage)').all() as Array<{ name: string }>).map((column) => column.name))
        .toEqual(expect.arrayContaining(['cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'batch_id', 'trigger_reason',
          'input_item_count', 'attempt_number']));
      expect(db.prepare("SELECT kind FROM pi_conversations WHERE id='legacy'").get()).toMatchObject({ kind: 'streamer_legacy_v1' });
      expect(db.prepare("SELECT COUNT(*) count FROM jobs WHERE type='pi_analyze'").get()).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) count FROM dynamics WHERE type='DYNAMIC_TYPE_LIVE_RCMD'").get()).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) count FROM jobs WHERE entity_id='legacy-live-card'").get()).toMatchObject({ count: 0 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pi_revision_analyses'").get()).toBeTruthy();
      expect((db.prepare('PRAGMA table_info(dynamics)').all() as Array<{ name: string }>).map((column) => column.name))
        .toEqual(expect.arrayContaining(['is_pinned', 'last_content_change_at']));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
