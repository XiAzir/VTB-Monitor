import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueJob, getDynamic, getStreamerById, listComments, listDynamicRevisions, listReplies } from '$lib/server/store';
import type { Actions } from './$types';

export const load: PageServerLoad = ({ params, url }) => {
  const dynamic = getDynamic(params.id);
  if (!dynamic) error(404, '动态不存在');
  const streamerRow = getDb().prepare('SELECT id,slug,name,bili_uid,room_id,avatar_url FROM streamers WHERE id=?').get(dynamic.streamerId) as Record<string, unknown> | undefined;
  if (!streamerRow) error(404, '主播不存在');
  const roots = listComments(dynamic.id, 50);
  const comments = roots.map((root) => ({ ...root, replies: listReplies(dynamic.id, root.id) }));
  const revisions = listDynamicRevisions(dynamic.id);
  const selectedRevision = url.searchParams.get('revision');
  return { dynamic, streamer: streamerRow, comments, revisions, selectedRevision: selectedRevision ? revisions.find((item) => item.id === selectedRevision) ?? null : null };
};

export const actions: Actions = {
  refresh: ({ params }) => {
    enqueueJob('refresh_dynamic', params.id, {}, 5, new Date().toISOString(), `refresh-dynamic:${params.id}:${Date.now()}`);
    return { queued: true };
  }
};
