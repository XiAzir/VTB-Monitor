use anyhow::Result;
use rusqlite::{params,Connection};
use serde_json::json;
use vtb_monitor_rs::{business,db};
#[test]
fn hybrid_edits_use_original_pi_revision_contract_without_premature_invalidation()->Result<()> {
    let mut c=Connection::open_in_memory()?;db::migrate(&mut c)?;
    let sid=business::create_streamer(&mut c,&json!({"name":"hybrid","slug":"hybrid","biliUid":"123","roomId":"456","enabled":false}),"test")?;
    let mut value=json!({"id":"post","text":"明天20点","type":"DYNAMIC_TYPE_WORD","publishedAt":"2026-09-12T12:00:00.000Z","mediaUrls":[],"raw":{}});
    business::upsert_dynamic_with_pi(&mut c,&sid,&value)?;
    c.execute("INSERT INTO timeline_events(id,streamer_id,event_type,source_type,source_id,confidence,event_key,created_at,updated_at) VALUES('event',?,'scheduled','dynamic','post',90,'key',?,?)",params![sid,db::now(),db::now()])?;
    c.execute("DELETE FROM jobs",[])?;
    value["text"]=json!("明天21点");business::upsert_dynamic_with_pi(&mut c,&sid,&value)?;
    assert_eq!(c.query_row("SELECT active FROM timeline_events WHERE id='event'",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(c.query_row("SELECT count(*) FROM pi_revision_analyses WHERE status='pending'",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(c.query_row("SELECT count(*) FROM jobs WHERE type='pi_revision'",[],|r|r.get::<_,i64>(0))?,1);
    assert_eq!(c.query_row("SELECT count(*) FROM jobs WHERE type='rs_analyze_dynamic'",[],|r|r.get::<_,i64>(0))?,0);
    business::upsert_dynamic_with_pi(&mut c,&sid,&value)?;
    assert_eq!(c.query_row("SELECT count(*) FROM dynamic_revisions",[],|r|r.get::<_,i64>(0))?,1);
    Ok(())
}
