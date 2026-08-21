import { afterAll, describe, expect, it, vi } from 'vitest';
import { BilibiliClient, extractInitialState, normalizeComment, normalizeDynamic, resolveRoomRecord } from './bilibili';
import { closeDb, getDb } from './db';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './security';
import {
  createStreamer, enqueueJob, getSecret, leaseNextJob, listComments, listDynamics, markMissingRootCommentsUnavailable, putSecret,
  setForecast, upsertComment, upsertDynamic
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
      expect(states.get('510')).toMatchObject({ status: 'live', title: '看比赛咯', uid: '7706705' });
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
  });

  it('records revisions, comment hierarchy, and protects manual forecasts', () => {
    const streamerId = createStreamer({ slug: 'tester', name: '测试主播', biliUid: '10001', roomId: '20001' });
    const base = { id: 'dyn-1', streamerId, type: 'word', sourceUrl: 'https://example.invalid/1',
      publishedAt: new Date().toISOString(), text: '第一版' };
    expect(upsertDynamic(base).created).toBe(true);
    expect(upsertDynamic({ ...base, text: '第二版' }).changed).toBe(true);
    expect(listDynamics(streamerId)[0].text).toBe('第二版');
    expect(Number((getDb().prepare('SELECT COUNT(*) count FROM dynamic_revisions').get() as { count: number }).count)).toBe(1);
    upsertComment({ id: 'c1', dynamicId: 'dyn-1', authorUid: '10001', authorName: '测试主播', message: '今晚晚点',
      isStreamer: true, publishedAt: new Date().toISOString() });
    expect(listComments('dyn-1')[0]).toMatchObject({ id: 'c1', isStreamer: true });
    markMissingRootCommentsUnavailable('dyn-1', []);
    expect(listComments('dyn-1')[0].state).toBe('unavailable');

    setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 3600_000).toISOString(), confidence: 100,
      source: 'manual', reason: '人工', evidence: [] }, 'test');
    expect(() => setForecast({ streamerId, predictedStartAt: new Date(Date.now() + 7200_000).toISOString(), confidence: 80,
      source: 'pi', reason: 'AI', evidence: [] }, 'pi')).toThrow('人工预测已锁定');
  });
});
