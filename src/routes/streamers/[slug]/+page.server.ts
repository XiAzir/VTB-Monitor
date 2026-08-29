import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueJob, getPredictionEvaluationSummary, getStreamerBySlug, listDynamicsPage, listScheduleRules } from '$lib/server/store';
import type { DynamicRecord } from '$lib/types';

export const load: PageServerLoad = ({ params, locals, url }) => {
  const streamer = getStreamerBySlug(params.slug);
  if (!streamer) error(404, '主播不存在');
  const liveSessions = getDb().prepare(`SELECT id,title,observed_start_at,observed_end_at FROM live_sessions
    WHERE streamer_id=? ORDER BY observed_start_at DESC LIMIT 12`).all(streamer.id);
  const exceptions = getDb().prepare(`SELECT * FROM schedule_exceptions WHERE streamer_id=?
    AND occurrence_date >= date('now','-7 day') ORDER BY occurrence_date,start_at`).all(streamer.id);
  const filters = parseFilters(url.searchParams);
  const page = listDynamicsPage(streamer.id, 30, url.searchParams.get('cursor') ?? undefined, filters);
  const nextParams = new URLSearchParams(url.searchParams);
  nextParams.delete('cursor');
  if (page.nextCursor) nextParams.set('cursor', page.nextCursor);
  const dynamicTypes = (getDb().prepare('SELECT DISTINCT type FROM dynamics WHERE streamer_id=? ORDER BY type').all(streamer.id) as Array<{ type: string }>).map((row) => row.type);
  return { streamer, dynamics: page.items, nextCursor: page.nextCursor,
    nextHref: page.nextCursor ? `${url.pathname}?${nextParams.toString()}` : null, filters, dynamicTypes,
    scheduleRules: listScheduleRules(streamer.id), exceptions, liveSessions, evaluation: getPredictionEvaluationSummary(streamer.id),
    canRefresh: Boolean(locals.adminSession && !locals.adminSession.forcePasswordChange) };
};

function parseFilters(params: URLSearchParams) {
  const date = (name: string) => isValidDate(params.get(name) ?? '') ? params.get(name)! : '';
  const states = new Set<DynamicRecord['state']>(['visible', 'suspected_deleted', 'deleted', 'unavailable']);
  const state = params.get('state') as DynamicRecord['state'] | null;
  return {
    q: (params.get('q') ?? '').trim().slice(0, 100), from: date('from'), to: date('to'),
    type: (params.get('type') ?? '').slice(0, 100), state: state && states.has(state) ? state : undefined,
    hasMedia: params.get('hasMedia') === '1', changedOnly: params.get('changedOnly') === '1'
  };
}

function isValidDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

export const actions: Actions = {
  refresh: ({ params, locals }) => {
    if (!locals.adminSession) redirect(303, '/admin');
    if (locals.adminSession.forcePasswordChange) error(403, '请先修改初始化管理员密码');
    const streamer = getStreamerBySlug(params.slug);
    if (!streamer) error(404, '主播不存在');
    enqueueJob('sync_streamer', streamer.id, { fullSync: true }, 5, new Date().toISOString(), `manual-full-sync:${streamer.id}:${Date.now()}`);
    return { queued: true };
  }
};
