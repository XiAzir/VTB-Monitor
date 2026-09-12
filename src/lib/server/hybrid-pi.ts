/** Rust is the sole queue owner. Pi continues using its original TS implementation. */
import { closeDb, getDb } from './db';
import { getDynamic, getSetting, getSecret, stagePiDynamicIds, createManualScheduleDraft, refreshForecastFromSchedules } from './store';
import { piRuntime, type PiProfile } from './pi-profile';

type Job = { type: string; entityId: string; payload?: Record<string, unknown>; attemptNumber?: number };
type Bridge = { run(input: unknown): Promise<void>; readonly busy: boolean; close(): void };
const bridgeKey = Symbol.for('vtbm.hybrid.pi.v1');
const globalRegistry = globalThis as unknown as Record<symbol, Bridge | undefined>;
const allowed = new Set(['pi_analyze', 'pi_revision', 'recognize_schedule', 'rs_analyze_dynamic', 'hybrid_roll_schedule']);

export function registerHybridPi(): void {
  if (process.env.VTBM_HYBRID_CHILD !== '1' || globalRegistry[bridgeKey]) return;
  let busy = false;
  globalRegistry[bridgeKey] = {
    get busy() { return busy; },
    close: closeDb,
    async run(input: unknown): Promise<void> {
      if (!input || typeof input !== 'object') throw new Error('Invalid Pi job');
      const job = input as Job;
      if (!allowed.has(job.type) || typeof job.entityId !== 'string' || job.entityId.length > 200 || !job.entityId) {
        throw new Error('Unsupported Pi job');
      }
      if (job.payload != null && (typeof job.payload !== 'object' || Array.isArray(job.payload))) throw new Error('Invalid Pi payload');
      if (busy || piRuntime.activeRuns > 0) throw new Error('BUSY: Pi is already running');
      busy = true;
      try {
        if (job.type === 'hybrid_roll_schedule') { refreshForecastFromSchedules(job.entityId); return; }
        const profile = getSetting<Partial<PiProfile>>('pi_profile', {});
        if (!getSecret(profile.apiKeySecret ?? 'pi_api_key')) throw new Error('DEPENDENCY: Pi API Key is not configured');
        const pi = await import('./pi');
        if (job.type === 'rs_analyze_dynamic') {
          const dynamic = getDynamic(job.entityId);
          if (!dynamic || dynamic.state !== 'visible') return;
          const row = getDb().prepare(`SELECT d.content_hash,p.content_hash AS analyzed_hash,s.enabled
            FROM dynamics d JOIN streamers s ON s.id=d.streamer_id
            LEFT JOIN pi_dynamic_analysis_versions p ON p.dynamic_id=d.id WHERE d.id=?`).get(dynamic.id) as { content_hash: string; analyzed_hash?: string; enabled: number } | undefined;
          // Compatibility with jobs emitted by the Rust archive writer. Baseline may
          // have consumed multiple posts; later per-post jobs must not repeat it.
          if (!row?.enabled || row.analyzed_hash === row.content_hash) return;
          if (dynamic.type !== 'DYNAMIC_TYPE_FORWARD' && dynamic.type !== 'forward' && dynamic.media.length > 0
            && /(周表|日程|本周|这周|突击|直播安排|直播日历|直播计划)/i.test(dynamic.text)) createManualScheduleDraft(dynamic.id);
          stagePiDynamicIds(dynamic.streamerId, [dynamic.id]);
          await pi.analyzeStreamerWithPi(dynamic.streamerId, { mode: 'incremental', triggerReason: 'rust_content_changed', attemptNumber: job.attemptNumber ?? 1 });
        } else if (job.type === 'pi_analyze') {
          await pi.analyzeStreamerWithPi(job.entityId, { ...job.payload, attemptNumber: job.attemptNumber ?? 1 });
        } else if (job.type === 'pi_revision') {
          getDb().prepare("UPDATE pi_revision_analyses SET status='pending' WHERE revision_id=? AND status='processing'").run(job.entityId);
          await pi.analyzeDynamicRevisionWithPi(job.entityId, job.attemptNumber ?? 1);
        } else {
          getDb().prepare("UPDATE schedule_drafts SET status='pending' WHERE id=? AND status IN ('processing','failed')").run(job.entityId);
          await pi.recognizeScheduleDraftWithPi(job.entityId);
        }
      } catch (error) {
        if (error instanceof Error && ['PiLeaseBusyError'].includes(error.name)) throw new Error(`BUSY: ${error.message}`);
        if (error instanceof Error && ['ScheduleImagesPendingError', 'PiRevisionMediaPendingError'].includes(error.name)) throw new Error(`DEPENDENCY: ${error.message}`);
        throw error;
      } finally { busy = false; }
    }
  };
}
