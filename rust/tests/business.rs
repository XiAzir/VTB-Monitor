use anyhow::Result;
use chrono::{Duration,Utc,Datelike};
use rusqlite::{Connection,params};
use serde_json::{json,Value};
use vtb_monitor_rs::{business as b,db,time};

fn fixture()->Result<(Connection,String)> {
    let mut connection=Connection::open_in_memory()?;
    connection.execute_batch("PRAGMA foreign_keys=ON")?;db::migrate(&mut connection)?;
    let sid=b::create_streamer(&mut connection,&json!({"name":"fixture","slug":"fixture","biliUid":"123","roomId":"456","enabled":false,"timezone":"Asia/Shanghai"}),"test")?;
    Ok((connection,sid))
}
fn dynamic(id:&str)->Value {
    json!({"id":id,"type":"DYNAMIC_TYPE_DRAW","text":"","mediaUrls":["https://i0.hdslb.com/a.png"],"publishedAt":"2026-09-12T12:00:00.000Z","raw":{"emojiMap":{},"card":null},"isPinned":true,"commentCount":30,"likeCount":40})
}
#[test] fn image_only_dynamic_is_archived_and_enqueued()->Result<()> {
    let(mut connection,sid)=fixture()?;
    assert_eq!(b::upsert_dynamic(&mut connection,&sid,&dynamic("d1"))?,(true,true));
    assert_eq!(connection.query_row("SELECT count(*) FROM pi_pending_dynamics",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(b::media(&connection,"d1")?.len(),1);Ok(())
}
#[test] fn unchanged_content_does_not_create_revision()->Result<()> {
    let(mut c,sid)=fixture()?;let d=dynamic("d1");b::upsert_dynamic(&mut c,&sid,&d)?;
    assert_eq!(b::upsert_dynamic(&mut c,&sid,&d)?,(false,false));
    assert_eq!(c.query_row("SELECT count(*) FROM dynamic_revisions",[],|r|r.get::<_,i64>(0))?,0);Ok(())
}
#[test] fn emoji_content_change_creates_revision()->Result<()> {
    let(mut c,sid)=fixture()?;let mut d=dynamic("d1");b::upsert_dynamic(&mut c,&sid,&d)?;
    d["raw"]["emojiMap"]=json!({"[hello]":"https://i0.hdslb.com/emoji.png"});
    assert_eq!(b::upsert_dynamic(&mut c,&sid,&d)?,(false,true));
    assert_eq!(c.query_row("SELECT count(*) FROM rs_media_refs WHERE owner_type='dynamic_revision'",[],|r|r.get::<_,i64>(0))?,1);Ok(())
}
#[test] fn video_counters_are_not_content_edits()->Result<()> {
    let(mut c,sid)=fixture()?;let mut d=dynamic("d1");d["raw"]["card"]=json!({"kind":"video","title":"Title","viewCount":1});b::upsert_dynamic(&mut c,&sid,&d)?;
    d["raw"]["card"]["viewCount"]=json!(10000);assert!(!b::upsert_dynamic(&mut c,&sid,&d)?.1);Ok(())
}
#[test] fn partial_refresh_does_not_zero_counters_or_unpin()->Result<()> {
    let(mut c,sid)=fixture()?;let mut d=dynamic("d1");b::upsert_dynamic(&mut c,&sid,&d)?;
    let object=d.as_object_mut().unwrap();for key in ["likeCount","commentCount","isPinned"]{object.remove(key);}
    b::upsert_dynamic(&mut c,&sid,&d)?;
    let row=db::one(&c,"SELECT like_count,comment_count,is_pinned FROM dynamics WHERE id='d1'",&[])?;
    assert_eq!(row["like_count"],40);assert_eq!(row["comment_count"],30);assert_eq!(row["is_pinned"],1);Ok(())
}
#[test] fn invalid_media_rolls_back_archive_write()->Result<()> {
    let(mut c,sid)=fixture()?;let mut d=dynamic("d1");d["mediaUrls"]=json!(["https://127.0.0.1/private"]);
    assert!(b::upsert_dynamic(&mut c,&sid,&d).is_err());assert_eq!(c.query_row("SELECT count(*) FROM dynamics",[],|r|r.get::<_,i64>(0))?,0);Ok(())
}
#[test] fn comment_image_edits_keep_revision_media_refs()->Result<()> {
    let(mut c,sid)=fixture()?;b::upsert_dynamic(&mut c,&sid,&dynamic("d1"))?;
    let mut comment=json!({"id":"c1","authorUid":"123","authorName":"name","message":"same text","publishedAt":"2026-09-12T12:00:00.000Z","mediaUrls":["https://i0.hdslb.com/a.png"]});
    b::upsert_comment(&mut c,"d1",&comment,"123")?;comment["mediaUrls"]=json!(["https://i0.hdslb.com/b.png"]);
    b::upsert_comment(&mut c,"d1",&comment,"123")?;
    assert_eq!(c.query_row("SELECT count(*) FROM comment_revisions",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(c.query_row("SELECT count(*) FROM rs_media_refs WHERE owner_type='comment_revision'",[],|r|r.get::<_,i64>(0))?,1);Ok(())
}
#[test] fn cancellation_with_no_replacement_stales_old_forecast()->Result<()> {
    let(mut c,sid)=fixture()?;let day=time::local_date(&db::after(86400),"Asia/Shanghai")?;let start=time::local_instant(&day.to_string(),"20:00","Asia/Shanghai")?;
    let fid=b::set_forecast(&c,&sid,&start,"schedule_confirmed","old",90,json!([]))?;
    c.execute("INSERT INTO schedule_exceptions(id,streamer_id,occurrence_date,status,title,source,source_ref,confidence,created_at,updated_at) VALUES('cancel',?,?,'cancelled','rest','schedule_confirmed','test',100,?,?)",params![sid,day.to_string(),db::now(),db::now()])?;
    assert!(b::refresh_forecast(&c,&sid)?.is_none());assert_eq!(db::one(&c,"SELECT stale FROM forecasts WHERE id=?",&[&fid])?["stale"],1);Ok(())
}
#[test] fn slot_cancellation_keeps_other_same_day_fixed_slot()->Result<()> {
    let(mut c,sid)=fixture()?;let day=time::local_date(&db::after(86400),"Asia/Shanghai")?;
    let weekday=day.weekday().number_from_monday();
    b::replace_rules(&mut c,&sid,&[json!({"weekday":weekday,"localTime":"12:00"}),json!({"weekday":weekday,"localTime":"20:00"})],"test")?;
    c.execute("INSERT INTO schedule_exceptions(id,streamer_id,occurrence_date,start_at,status,source,source_ref,confidence,created_at,updated_at) VALUES('cancel',?,?,?,'cancelled','schedule_confirmed','test',100,?,?)",params![sid,day.to_string(),time::local_instant(&day.to_string(),"12:00","Asia/Shanghai")?,db::now(),db::now()])?;
    b::refresh_forecast(&c,&sid)?;
    let forecast=db::one(&c,"SELECT predicted_start_at FROM forecasts WHERE streamer_id=? AND active=1",&[&sid])?;
    assert_eq!(forecast["predicted_start_at"],time::local_instant(&day.to_string(),"20:00","Asia/Shanghai")?);Ok(())
}
#[test] fn manual_forecast_survives_cancellation()->Result<()> {
    let(mut c,sid)=fixture()?;let fid=b::set_forecast(&c,&sid,&db::after(86400),"manual","locked",100,json!([]))?;
    b::refresh_forecast(&c,&sid)?;let row=db::one(&c,"SELECT stale,active FROM forecasts WHERE id=?",&[&fid])?;
    assert_eq!(row["stale"],0);assert_eq!(row["active"],1);Ok(())
}
#[test] fn edits_invalidate_timeline_derived_forecast()->Result<()> {
    let(mut c,sid)=fixture()?;let mut d=dynamic("d1");b::upsert_dynamic(&mut c,&sid,&d)?;
    c.execute("INSERT INTO timeline_events(id,streamer_id,event_type,planned_start_at,source_type,source_id,title,confidence,event_key,created_at,updated_at) VALUES('event',?,'scheduled',?,'dynamic','d1','old',90,'key',?,?)",params![sid,db::after(86400),db::now(),db::now()])?;
    let fid=b::set_forecast(&c,&sid,&db::after(86400),"dynamic","old",90,json!([{"type":"timeline_event","id":"event"}]))?;
    d["text"]=json!("cancelled");b::upsert_dynamic(&mut c,&sid,&d)?;
    assert_eq!(db::one(&c,"SELECT stale FROM forecasts WHERE id=?",&[&fid])?["stale"],1);Ok(())
}
#[test] fn loop_uses_legacy_rotating_enum()->Result<()> {
    let(mut c,sid)=fixture()?;b::update_live(&mut c,&sid,"loop","replay")?;
    assert_eq!(db::one(&c,"SELECT status FROM live_state WHERE streamer_id=?",&[&sid])?["status"],"rotating");Ok(())
}
#[test] fn unknown_does_not_end_live_and_end_creates_event()->Result<()> {
    let(mut c,sid)=fixture()?;b::update_live(&mut c,&sid,"live","started")?;
    assert!(b::update_live(&mut c,&sid,"unknown","").is_err());
    assert_eq!(c.query_row("SELECT count(*) FROM live_sessions WHERE observed_end_at IS NULL",[],|r|r.get::<_,i64>(0))?,1);
    b::update_live(&mut c,&sid,"offline","")?;
    assert_eq!(c.query_row("SELECT count(*) FROM timeline_events WHERE event_type='live_ended'",[],|r|r.get::<_,i64>(0))?,1);Ok(())
}
#[test] fn initial_live_observation_has_no_invented_lower_bound()->Result<()> {
    let(mut c,sid)=fixture()?;b::update_live(&mut c,&sid,"live","already live")?;
    assert!(db::one(&c,"SELECT lower_at FROM rs_observations LIMIT 1",&[])?["lower_at"].is_null());Ok(())
}
#[test] fn streamer_identity_change_invalidates_mapping()->Result<()> {
    let(mut c,sid)=fixture()?;c.execute("UPDATE streamers SET resolved_room_id='456',room_mapping_status='verified' WHERE id=?",[&sid])?;
    b::update_streamer(&mut c,&sid,&json!({"version":1,"roomId":"789","slug":"new-slug","avatarUrl":"https://i0.hdslb.com/face.png"}),"test")?;
    let s=db::one(&c,"SELECT room_id,slug,resolved_room_id,room_mapping_status FROM streamers WHERE id=?",&[&sid])?;
    assert_eq!(s["room_id"],"789");assert_eq!(s["slug"],"new-slug");assert!(s["resolved_room_id"].is_null());assert_eq!(s["room_mapping_status"],"unverified");Ok(())
}
