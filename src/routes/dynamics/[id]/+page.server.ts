import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { diffChars } from 'diff';
import { countRootComments, createManualScheduleDraft, enqueueJob, getDynamic, listCommentsPage, listDynamicRevisions, listReplies } from '$lib/server/store';
import type { Actions } from './$types';

export const load: PageServerLoad = ({ params, url, locals }) => {
  const dynamic = getDynamic(params.id);
  if (!dynamic) error(404, '动态不存在');
  const streamerRow = getDb().prepare('SELECT id,slug,name,bili_uid,room_id,avatar_url FROM streamers WHERE id=?').get(dynamic.streamerId) as Record<string, unknown> | undefined;
  if (!streamerRow) error(404, '主播不存在');
  const page = parsePage(url.searchParams.get('page'));
  const pageSize = 50;
  const before = page > 1 ? url.searchParams.get('before') ?? undefined : undefined;
  const commentPage = listCommentsPage(dynamic.id, pageSize, before);
  const roots = commentPage.items;
  const comments = roots.map((root) => ({ ...root, replies: listReplies(dynamic.id, root.id) }));
  const revisions = listDynamicRevisions(dynamic.id);
  const selectedRevision = url.searchParams.get('revision');
  const selected = selectedRevision ? revisions.find((item) => item.id === selectedRevision) ?? null : null;
  const currentVersion = { id: 'current', text: dynamic.text, createdAt: dynamic.updatedAt, snapshot: { state: dynamic.state },
    media: dynamic.media, emojiMap: dynamic.emojiMap ?? {}, card: dynamic.card };
  const versions = [currentVersion, ...revisions];
  const selectedIndex = selected ? versions.findIndex((item) => item.id === selected.id) : 0;
  const compareToId = url.searchParams.get('compareTo');
  const compareTo = compareToId ? versions.find((item) => item.id === compareToId) ?? null
    : selected && selectedIndex > 0 ? versions[selectedIndex - 1] : null;
  const comparison = selected && compareTo ? buildComparison(selected, compareTo) : null;
  return { dynamic, streamer: streamerRow, comments, totalRootComments: countRootComments(dynamic.id), page,
    nextBefore: commentPage.nextCursor, revisions, selectedRevision: selected, comparison,
    canRefresh: Boolean(locals.adminSession && !locals.adminSession.forcePasswordChange) };
};

function buildComparison(from: any, to: any) {
  const fromMedia = new Set((from.media ?? []).map((item: any) => String(item.sourceUrl)));
  const toMedia = new Set((to.media ?? []).map((item: any) => String(item.sourceUrl)));
  const fromEmoji = from.emojiMap ?? {};
  const toEmoji = to.emojiMap ?? {};
  return {
    from: { id: from.id, createdAt: from.createdAt }, to: { id: to.id, createdAt: to.createdAt },
    text: diffChars(String(from.snapshot?.text ?? from.text ?? ''), String(to.snapshot?.text ?? to.text ?? ''))
      .map((part) => ({ value: part.value, added: Boolean(part.added), removed: Boolean(part.removed) })),
    mediaAdded: [...toMedia].filter((url) => !fromMedia.has(url)), mediaRemoved: [...fromMedia].filter((url) => !toMedia.has(url)),
    emojiAdded: Object.keys(toEmoji).filter((key) => fromEmoji[key] !== toEmoji[key]),
    emojiRemoved: Object.keys(fromEmoji).filter((key) => !toEmoji[key]),
    stateFrom: String(from.snapshot?.state ?? 'visible'), stateTo: String(to.snapshot?.state ?? 'visible')
  };
}

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
  },
  markSchedule: ({ params, locals }) => {
    if (!locals.adminSession) redirect(303, '/admin');
    if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
    const id = createManualScheduleDraft(params.id);
    redirect(303, `/admin/schedules?draft=${id}`);
  }
};
