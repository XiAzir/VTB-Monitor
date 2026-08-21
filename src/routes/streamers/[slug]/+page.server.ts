import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { enqueueJob, getStreamerBySlug, listDynamics, listScheduleRules } from '$lib/server/store';

export const load: PageServerLoad = ({ params }) => {
  const streamer = getStreamerBySlug(params.slug);
  if (!streamer) error(404, '主播不存在');
  const liveSessions = getDb().prepare(`SELECT id,title,observed_start_at,observed_end_at FROM live_sessions
    WHERE streamer_id=? ORDER BY observed_start_at DESC LIMIT 12`).all(streamer.id);
  const exceptions = getDb().prepare(`SELECT * FROM schedule_exceptions WHERE streamer_id=?
    AND occurrence_date >= date('now','-7 day') ORDER BY occurrence_date,start_at`).all(streamer.id);
  return { streamer, dynamics: listDynamics(streamer.id, 20), scheduleRules: listScheduleRules(streamer.id), exceptions, liveSessions };
};

export const actions: Actions = {
  refresh: ({ params }) => {
    const streamer = getStreamerBySlug(params.slug);
    if (!streamer) error(404, '主播不存在');
    enqueueJob('sync_streamer', streamer.id, { fullSync: true }, 5, new Date().toISOString(), `manual-full-sync:${streamer.id}:${Date.now()}`);
    return { queued: true };
  }
};
