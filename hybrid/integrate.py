from pathlib import Path
root=Path(__file__).resolve().parent.parent

def edit(name, old, new, count=1):
    p=root/name;s=p.read_text()
    if s.count(old)!=count: raise SystemExit(f'Unexpected source anchor {name}: {s.count(old)} != {count}')
    p.write_text(s.replace(old,new))

edit('rust/src/hybrid.rs','    let url = url::Url::parse(&format!("http://127.0.0.1:{port}/{namespace}{path}"))?;', '''    if path.split('?').next().unwrap_or("").contains('\\\\') { bail!("backslash in request path"); }
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}/{namespace}{path}"))?;''')
edit('rust/src/business.rs','pub fn upsert_dynamic(db: &mut Connection, sid: &str, input: &Value) -> Result<(bool,bool)> {', '''pub fn upsert_dynamic(db: &mut Connection, sid: &str, input: &Value) -> Result<(bool,bool)> {
    upsert_dynamic_impl(db, sid, input, false)
}
pub fn upsert_dynamic_with_pi(db: &mut Connection, sid: &str, input: &Value) -> Result<(bool,bool)> {
    upsert_dynamic_impl(db, sid, input, true)
}
fn upsert_dynamic_impl(db: &mut Connection, sid: &str, input: &Value, original_pi: bool) -> Result<(bool,bool)> {''')
edit('rust/src/business.rs','        tx.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source!=\'manual\' AND (evidence_json LIKE ?', '''        if original_pi {
            // Preserve derived state for the original revision analyzer to decide
            // whether the edit cancels, moves or does not affect the announcement.
            tx.execute("INSERT INTO pi_revision_analyses(revision_id,dynamic_id,created_at,updated_at) VALUES(?,?,?,?)",params![rid,did,now(),now()])?;
            enqueue(&tx,"pi_revision",&rid,json!({"dynamicId":did}),24,30,&format!("pi-revision:{rid}"))?;
        } else {
        tx.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source!='manual' AND (evidence_json LIKE ?''')
edit('rust/src/business.rs','tx.execute("UPDATE timeline_events SET active=0,updated_at=? WHERE source_type=\'dynamic\' AND source_id=?",params![now(),did])?;', '''tx.execute("UPDATE timeline_events SET active=0,updated_at=? WHERE source_type='dynamic' AND source_id=?",params![now(),did])?;
        }''')
edit('rust/src/business.rs','    if changed {\n        tx.execute("INSERT INTO pi_pending_dynamics','    if changed && (!original_pi || existing.is_null()) {\n        tx.execute("INSERT INTO pi_pending_dynamics')
edit('rust/src/engine.rs','let sid=sid.to_owned();let scan=scan.clone();app.db.call(move|db|{business::upsert_dynamic(db,&sid,&dynamic)?;', '''let sid=sid.to_owned();let scan=scan.clone();let original_pi=app.bridge.is_some();app.db.call(move|db|{
            if original_pi { business::upsert_dynamic_with_pi(db,&sid,&dynamic)?; } else { business::upsert_dynamic(db,&sid,&dynamic)?; }''')
edit('rust/src/engine.rs','let sid=strv(&old,"streamer_id").to_owned();app.db.call(move|db|{business::upsert_dynamic(db,&sid,&detail)?;', '''let sid=strv(&old,"streamer_id").to_owned();let original_pi=app.bridge.is_some();app.db.call(move|db|{
        if original_pi { business::upsert_dynamic_with_pi(db,&sid,&detail)?; } else { business::upsert_dynamic(db,&sid,&detail)?; }''')
edit('src/lib/server/hybrid-pi.ts','getDynamic, getSetting, getSecret, stagePiDynamicIds','getDynamic, getSetting, getSecret, stagePiDynamicIds, createManualScheduleDraft, refreshForecastFromSchedules')
edit('src/lib/server/hybrid-pi.ts',"import type { PiProfile }", "import { piRuntime, type PiProfile }")
edit('src/lib/server/hybrid-pi.ts',"if (busy) throw new Error('BUSY: Pi is already running');", "if (busy || piRuntime.activeRuns > 0) throw new Error('BUSY: Pi is already running');")
edit('src/lib/server/hybrid-pi.ts',"          if (!row?.enabled || row.analyzed_hash === row.content_hash) return;", """          if (!row?.enabled || row.analyzed_hash === row.content_hash) return;
          if (dynamic.type !== 'DYNAMIC_TYPE_FORWARD' && dynamic.type !== 'forward' && dynamic.media.length > 0
            && /(周表|日程|本周|这周|突击|直播安排|直播日历|直播计划)/i.test(dynamic.text)) createManualScheduleDraft(dynamic.id);""")
edit('src/lib/server/pi.ts','    if (loadedImageCount === 0) {', '''    if (loadedImageCount < mediaUrls.length) {
      const incomplete = draftMediaState(mediaUrls);
      if (Number(incomplete.pending ?? 0) > 0) {
        getDb().prepare("UPDATE schedule_drafts SET status='pending',error=?,updated_at=? WHERE id=? AND status='processing'")
          .run('等待全部周表图片完成本地归档', new Date().toISOString(), draftId);
        throw new ScheduleImagesPendingError();
      }
      throw new Error('周表图片未完整归档，未提交部分识别结果');
    }
    if (loadedImageCount === 0) {''')
# A completed schedule must still roll forward while the original UI is idle.
# This operation uses only the original store and does not import the Pi SDK.
edit('src/lib/server/hybrid-pi.ts',"'recognize_schedule', 'rs_analyze_dynamic'", "'recognize_schedule', 'rs_analyze_dynamic', 'hybrid_roll_schedule'")
edit('src/lib/server/hybrid-pi.ts',"        const profile = getSetting", "        if (job.type === 'hybrid_roll_schedule') { refreshForecastFromSchedules(job.entityId); return; }\n        const profile = getSetting")
edit('rust/src/engine.rs','async fn enqueue_due(app:&Arc<App>)->Result<()>{\n    app.db.call(|db|{','async fn enqueue_due(app:&Arc<App>)->Result<()>{\n    let original_pi=app.bridge.is_some();\n    app.db.call(move|db|{')
edit('rust/src/engine.rs','        db.execute("UPDATE forecasts SET stale=1 WHERE active=1 AND stale=0 AND predicted_start_at<=?",[now()])?;', '''        if original_pi {
            let expired=rows(db,"SELECT f.id,f.streamer_id FROM forecasts f JOIN streamers s ON s.id=f.streamer_id WHERE f.active=1 AND s.enabled=1 AND f.predicted_start_at<=? AND f.source IN ('weekly_schedule','schedule_confirmed') AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.dedupe_key='hybrid-roll:'||f.id) LIMIT 20",&[&now()],20)?;
            for f in expired { enqueue(db,"hybrid_roll_schedule",strv(&f,"streamer_id"),json!({}),30,0,&format!("hybrid-roll:{}",strv(&f,"id")))?; }
        }
        db.execute("UPDATE forecasts SET stale=1 WHERE active=1 AND stale=0 AND predicted_start_at<=?",[now()])?;''')
edit('rust/src/engine.rs','["rs_analyze_dynamic", "pi_analyze", "pi_revision", "recognize_schedule"]','["rs_analyze_dynamic", "pi_analyze", "pi_revision", "recognize_schedule", "hybrid_roll_schedule"]')
print('Reviewed namespace, revision-dispatch, schedule rollover and complete-image fixes materialized.')
