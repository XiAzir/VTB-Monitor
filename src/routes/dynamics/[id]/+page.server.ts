import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { countRootComments, enqueueJob, getDynamic, getStreamerById, listComments, listDynamicRevisions, listReplies } from '$lib/server/store';
import type { Actions } from './$types';

export const load: PageServerLoad = ({ params, url, locals }) => {
  const dynamic = getDynamic(params.id);
  if (!dynamic) error(404, '动态不存在');
  const streamerRow = getDb().prepare('SELECT id,slug,name,bili_uid,room_id,avatar_url FROM streamers WHERE id=?').get(dynamic.streamerId) as Record<string, unknown> | undefined;
  if (!streamerRow) error(404, '主播不存在');
  const page = parsePage(url.searchParams.get('page'));
  const pageSize = 50;
  const before = page > 1 ? url.searchParams.get('before') ?? undefined : undefined;
  const roots = listComments(dynamic.id, pageSize, before);
  const comments = roots.map((root) => ({ ...root, replies: listReplies(dynamic.id, root.id) }));
  const revisions = listDynamicRevisions(dynamic.id);
  const selectedRevision = url.searchParams.get('revision');
  return { dynamic, streamer: streamerRow, comments, totalRootComments: countRootComments(dynamic.id), page,
    nextBefore: roots.length === pageSize ? roots.at(-1)?.publishedAt ?? null : null, revisions,
    selectedRevision: selectedRevision ? revisions.find((item) => item.id === selectedRevision) ?? null : null,
    canRefresh: Boolean(locals.adminSession && !locals.adminSession.forcePasswordChange) };
};

function parsePage(value: string | null): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1;
}

export const actions: Actions = {
  refresh: ({ params, locals }) => {
    if (!locals.adminSession) redirect(303, '/admin');
    if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
    if (!getDynamic(params.id)) error(404, '动态不存在');
    enqueueJob('refresh_dynamic', params.id, {}, 5, new Date().toISOString(), `refresh-dynamic:${params.id}:${Date.now()}`);
    return { queued: true };
  }
};
