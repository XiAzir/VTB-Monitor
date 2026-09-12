use anyhow::{bail, Context, Result};
use chrono::{Datelike, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use crate::{db::*, security, time};

pub fn required<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let text = strv(value, key);
    if text.trim().is_empty() || text.len() > max { bail!("invalid/missing {key}"); }
    Ok(text)
}
fn validate_identity(slug: &str, uid: &str, room: &str, zone: &str) -> Result<()> {
    if slug.is_empty() || slug.len() > 100 || !slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { bail!("invalid slug"); }
    for value in [uid, room] { if value.is_empty() || value.len() > 30 || !value.bytes().all(|b| b.is_ascii_digit()) { bail!("UID/roomId must be decimal strings"); } }
    let _: chrono_tz::Tz = zone.parse().context("invalid IANA timezone")?;
    Ok(())
}
fn public_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value)?;
    if !["https", "http"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || value.len() > 2048 { bail!("invalid public URL"); }
    Ok(())
}
pub fn create_streamer(db: &mut Connection, input: &Value, actor: &str) -> Result<String> {
    let name = required(input, "name", 200)?;
    let slug = required(input, "slug", 100)?;
    let uid = required(input, "biliUid", 30)?;
    let room = required(input, "roomId", 30)?;
    let zone = input["timezone"].as_str().unwrap_or("Asia/Shanghai");
    validate_identity(slug, uid, room, zone)?;
    let dynamic_url = input["dynamicUrl"].as_str().map(String::from).unwrap_or_else(|| format!("https://space.bilibili.com/{uid}/dynamic"));
    let live_url = input["liveUrl"].as_str().map(String::from).unwrap_or_else(|| format!("https://live.bilibili.com/{room}"));
    public_url(&dynamic_url)?; public_url(&live_url)?;
    if let Some(avatar) = input["avatarUrl"].as_str() { public_url(avatar)?; }
    let sid = id(); let timestamp = now(); let tx = db.savepoint()?;
    tx.execute("INSERT INTO streamers(id,slug,name,bili_uid,room_id,dynamic_url,live_url,avatar_url,timezone,enabled,live_poll_seconds,dynamic_poll_seconds,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![sid,slug,name,uid,room,dynamic_url,live_url,input["avatarUrl"].as_str(),zone,input["enabled"].as_bool().unwrap_or(true) as i64,number(input,"livePollSeconds",30).clamp(15,600),number(input,"dynamicPollSeconds",300).clamp(180,3600),timestamp,timestamp])?;
    tx.execute("INSERT INTO live_state(streamer_id,status) VALUES(?,'unknown')", [&sid])?;
    tx.execute("INSERT INTO pi_event_cursors(streamer_id,updated_at) VALUES(?,?)", params![sid,timestamp])?;
    enqueue(&tx,"sync_streamer",&sid,json!({}),10,0,&format!("initial:{sid}"))?;
    audit(&tx,actor,"streamer.create","streamer",&sid,json!({"name":name}))?;
    tx.commit()?; Ok(sid)
}
pub fn update_streamer(db: &mut Connection, sid: &str, input: &Value, actor: &str) -> Result<()> {
    let old = one(db,"SELECT * FROM streamers WHERE id=?",&[&sid])?;
    if old.is_null() { bail!("NOT_FOUND: streamer"); }
    let version = number(input,"version",0);
    if version != number(&old,"version",1) { bail!("CONFLICT: stale configuration version"); }
    let name = input["name"].as_str().unwrap_or(strv(&old,"name"));
    if name.trim().is_empty() || name.len() > 200 { bail!("invalid name"); }
    let slug = input["slug"].as_str().unwrap_or(strv(&old,"slug"));
    let uid = input["biliUid"].as_str().unwrap_or(strv(&old,"bili_uid"));
    let room = input["roomId"].as_str().unwrap_or(strv(&old,"room_id"));
    let zone = input["timezone"].as_str().unwrap_or(strv(&old,"timezone"));
    validate_identity(slug,uid,room,zone)?;
    let dynamic_url = input["dynamicUrl"].as_str().unwrap_or(strv(&old,"dynamic_url"));
    let live_url = input["liveUrl"].as_str().unwrap_or(strv(&old,"live_url"));
    public_url(dynamic_url)?; public_url(live_url)?;
    let avatar = if input.get("avatarUrl").is_some() { input["avatarUrl"].as_str() } else { old["avatar_url"].as_str() };
    if let Some(url) = avatar { public_url(url)?; }
    let identity_changed = uid != strv(&old,"bili_uid") || room != strv(&old,"room_id");
    let tx = db.savepoint()?;
    let count = tx.execute("UPDATE streamers SET name=?,slug=?,bili_uid=?,room_id=?,dynamic_url=?,live_url=?,avatar_url=?,timezone=?,enabled=?,live_poll_seconds=?,dynamic_poll_seconds=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        params![name,slug,uid,room,dynamic_url,live_url,avatar,zone,input["enabled"].as_bool().map(|b|b as i64).unwrap_or(number(&old,"enabled",1)),number(input,"livePollSeconds",number(&old,"live_poll_seconds",30)).clamp(15,600),number(input,"dynamicPollSeconds",number(&old,"dynamic_poll_seconds",300)).clamp(180,3600),now(),sid,version])?;
    if count != 1 { bail!("CONFLICT: stale configuration version"); }
    if identity_changed {
        tx.execute("UPDATE streamers SET resolved_room_id=NULL,room_short_id=NULL,room_mapping_status='unverified',last_dynamic_sync_at=NULL WHERE id=?",[sid])?;
        tx.execute("UPDATE live_state SET status='unknown',checked_at=NULL WHERE streamer_id=?",[sid])?;
        tx.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source!='manual'",[sid])?;
    }
    audit(&tx,actor,"streamer.update","streamer",sid,input.clone())?;
    tx.commit()?; Ok(())
}
pub fn link_media(db: &Connection, kind: &str, owner: &str, urls: &[Value]) -> Result<()> {
    let (table,column) = match kind { "dynamic" => ("dynamic_media","dynamic_id"), "comment" => ("comment_media","comment_id"), _ => bail!("invalid media owner") };
    if urls.len() > 100 { bail!("too many media references"); }
    db.execute(&format!("DELETE FROM {table} WHERE {column}=?"),[owner])?;
    for (position,value) in urls.iter().enumerate() {
        let Some(url) = value.as_str() else { bail!("invalid media URL"); };
        let parsed = url::Url::parse(url)?; let host = parsed.host_str().unwrap_or("");
        if !["https","http"].contains(&parsed.scheme()) || !(host=="hdslb.com" || host.ends_with(".hdslb.com")) || parsed.port().is_some() || !parsed.username().is_empty() || parsed.password().is_some() { bail!("untrusted media reference"); }
        let existing: Option<String> = db.query_row("SELECT id FROM media_assets WHERE source_url=? UNION ALL SELECT media_id FROM media_source_aliases WHERE source_url=? LIMIT 1",params![url,url],|r|r.get(0)).optional()?;
        let mid = existing.unwrap_or_else(id);
        db.execute("INSERT OR IGNORE INTO media_assets(id,source_url,created_at,updated_at) VALUES(?,?,?,?)",params![mid,url,now(),now()])?;
        db.execute(&format!("INSERT OR IGNORE INTO {table}({column},media_id,position,source_url) VALUES(?,?,?,?)"),params![owner,mid,position as i64,url])?;
        enqueue(db,"download_media",&mid,json!({}),20,0,&format!("media:{mid}"))?;
    }
    Ok(())
}
pub fn media(db: &Connection, dynamic: &str) -> Result<Vec<Value>> {
    rows(db,"SELECT m.id,m.sha256,m.mime_type,m.byte_size,m.state,m.local_path,COALESCE(dm.source_url,m.source_url) source_url FROM dynamic_media dm JOIN media_assets m ON m.id=dm.media_id WHERE dm.dynamic_id=? ORDER BY dm.position LIMIT 100",&[&dynamic],100)
}
fn semantic_metadata(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            for key in ["viewCount","danmakuCount","likeCount","commentCount"] { object.remove(key); }
            for child in object.values_mut() { *child = semantic_metadata(child.take()); }
        }
        Value::Array(array) => for child in array { *child = semantic_metadata(child.take()); },
        _ => ()
    }
    value
}
pub fn upsert_dynamic(db: &mut Connection, sid: &str, input: &Value) -> Result<(bool,bool)> {
    let did = required(input,"id",40)?; let text = input["text"].as_str().unwrap_or("");
    if text.len() > 128*1024 { bail!("dynamic needs chunking; not marking it analyzed"); }
    let published = required(input,"publishedAt",50)?; chrono::DateTime::parse_from_rfc3339(published)?;
    let kind = required(input,"type",80)?;
    let urls = input["mediaUrls"].as_array().cloned().unwrap_or_default();
    let existing = one(db,"SELECT * FROM dynamics WHERE id=?",&[&did])?;
    if !existing.is_null() && strv(&existing,"streamer_id") != sid { bail!("dynamic owner mismatch"); }
    let old_media = media(db,did)?;
    let old_urls: Vec<Value> = old_media.iter().map(|m|m["source_url"].clone()).collect();
    let old_raw: Value = serde_json::from_str(strv(&existing,"raw_excerpt")).unwrap_or(Value::Null);
    let raw = input.get("raw").cloned().unwrap_or_else(||old_raw.clone());
    if raw.to_string().len() > 128*1024 { bail!("dynamic metadata exceeds budget"); }
    let semantic = semantic_metadata(raw.clone());
    let changed = existing.is_null() || strv(&existing,"text") != text || old_urls != urls || strv(&existing,"type") != kind || semantic_metadata(old_raw) != semantic;
    let hash = if changed { security::digest(json!({"text":text,"type":kind,"media":urls,"metadata":semantic}).to_string()) } else { strv(&existing,"content_hash").to_owned() };
    let tx = db.savepoint()?;
    if !existing.is_null() && changed {
        let rid = id(); let mut snapshot = existing.clone(); snapshot["mediaUrls"] = json!(old_urls);
        tx.execute("INSERT INTO dynamic_revisions(id,dynamic_id,text,content_hash,snapshot_json,created_at) VALUES(?,?,?,?,?,?)",params![rid,did,strv(&existing,"text"),strv(&existing,"content_hash"),snapshot.to_string(),now()])?;
        for item in &old_media { tx.execute("INSERT OR IGNORE INTO rs_media_refs VALUES('dynamic_revision',?,?)",params![rid,strv(item,"id")])?; }
        tx.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source!='manual' AND (evidence_json LIKE ? OR EXISTS(SELECT 1 FROM json_each(forecasts.evidence_json) e JOIN timeline_events t ON t.id=json_extract(e.value,'$.id') WHERE t.source_type='dynamic' AND t.source_id=?))",params![sid,format!("%{did}%"),did])?;
        tx.execute("UPDATE timeline_events SET active=0,updated_at=? WHERE source_type='dynamic' AND source_id=?",params![now(),did])?;
    }
    tx.execute("INSERT INTO dynamics(id,streamer_id,type,text,source_url,published_at,updated_at,last_seen_at,content_hash,comment_oid,comment_type,comment_count,like_count,raw_excerpt,is_pinned,last_content_change_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,text=excluded.text,state='visible',updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,content_hash=excluded.content_hash,comment_oid=COALESCE(NULLIF(excluded.comment_oid,''),dynamics.comment_oid),comment_type=COALESCE(NULLIF(excluded.comment_type,''),dynamics.comment_type),comment_count=excluded.comment_count,like_count=excluded.like_count,raw_excerpt=excluded.raw_excerpt,is_pinned=excluded.is_pinned,missing_complete_scans=0,last_missing_scan_id=NULL,last_content_change_at=CASE WHEN dynamics.content_hash!=excluded.content_hash THEN excluded.updated_at ELSE dynamics.last_content_change_at END",
        params![did,sid,kind,text,format!("https://t.bilibili.com/{did}"),published,now(),now(),hash,input["commentOid"].as_str(),input["commentType"].as_str(),number(input,"commentCount",number(&existing,"comment_count",0)),number(input,"likeCount",number(&existing,"like_count",0)),raw.to_string(),input["isPinned"].as_bool().map(|b|b as i64).unwrap_or(number(&existing,"is_pinned",0)),published])?;
    if old_urls != urls || existing.is_null() { link_media(&tx,"dynamic",did,&urls)?; }
    if existing.is_null() {
        tx.execute("INSERT OR IGNORE INTO comment_sync_state(dynamic_id,next_sync_at,updated_at) VALUES(?,?,?)",params![did,now(),now()])?;
        enqueue(&tx,"sync_comments",did,json!({}),50,0,&format!("comments-initial:{did}"))?;
    }
    if changed {
        tx.execute("INSERT INTO pi_pending_dynamics(streamer_id,dynamic_id,detected_at) VALUES(?,?,?) ON CONFLICT(streamer_id,dynamic_id) DO UPDATE SET detected_at=excluded.detected_at",params![sid,did,now()])?;
        enqueue(&tx,"rs_analyze_dynamic",did,json!({"contentHash":hash}),35,30,&format!("analysis:{did}:{hash}"))?;
    }
    tx.commit()?; Ok((existing.is_null(),changed))
}
pub fn upsert_comment(db: &mut Connection, did: &str, value: &Value, streamer_uid: &str) -> Result<()> {
    let cid = required(value,"id",40)?; let message = strv(value,"message");
    if message.len() > 65536 { bail!("comment too large"); }
    let old = one(db,"SELECT * FROM comments WHERE id=?",&[&cid])?;
    if !old.is_null() && strv(&old,"dynamic_id") != did { bail!("comment owner mismatch"); }
    let urls = value["mediaUrls"].as_array().cloned().unwrap_or_default();
    let hash = security::digest(json!({"message":message,"media":urls}).to_string());
    let old_media = rows(db,"SELECT cm.media_id,COALESCE(cm.source_url,m.source_url) source_url FROM comment_media cm JOIN media_assets m ON m.id=cm.media_id WHERE cm.comment_id=? ORDER BY cm.position LIMIT 100",&[&cid],100)?;
    let old_urls: Vec<Value> = old_media.iter().map(|m|m["source_url"].clone()).collect();
    let tx = db.savepoint()?;
    if !old.is_null() && (strv(&old,"message") != message || old_urls != urls) {
        let rid = id(); let mut snapshot = old.clone(); snapshot["mediaUrls"] = json!(old_urls);
        tx.execute("INSERT INTO comment_revisions(id,comment_id,message,content_hash,snapshot_json,created_at) VALUES(?,?,?,?,?,?)",params![rid,cid,strv(&old,"message"),strv(&old,"content_hash"),snapshot.to_string(),now()])?;
        for item in &old_media { tx.execute("INSERT OR IGNORE INTO rs_media_refs VALUES('comment_revision',?,?)",params![rid,strv(item,"media_id")])?; }
    }
    tx.execute("INSERT INTO comments(id,dynamic_id,root_id,parent_id,author_uid,author_name,avatar_url,message,like_count,reply_count,is_pinned,is_streamer,content_hash,published_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET author_name=excluded.author_name,avatar_url=excluded.avatar_url,message=excluded.message,like_count=excluded.like_count,reply_count=excluded.reply_count,is_pinned=excluded.is_pinned,is_streamer=excluded.is_streamer,state='visible',content_hash=excluded.content_hash,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at",
        params![cid,did,value["rootId"].as_str(),value["parentId"].as_str(),strv(value,"authorUid"),strv(value,"authorName"),value["avatarUrl"].as_str(),message,number(value,"likeCount",0),number(value,"replyCount",0),value["isPinned"].as_bool().unwrap_or(false) as i64,(strv(value,"authorUid")==streamer_uid) as i64,hash,required(value,"publishedAt",50)?,now(),now()])?;
    if old_urls != urls || old.is_null() { link_media(&tx,"comment",cid,&urls)?; }
    tx.commit()?; Ok(())
}
pub fn set_forecast(db: &Connection, sid: &str, start: &str, source: &str, reason: &str, confidence: i64, evidence: Value) -> Result<String> {
    let date = chrono::DateTime::parse_from_rfc3339(start)?.with_timezone(&Utc);
    if date <= Utc::now() || date > Utc::now()+Duration::days(8) { bail!("forecast must be within future 8 days"); }
    if !(0..=100).contains(&confidence) || reason.len()>2000 { bail!("invalid forecast"); }
    let manual = one(db,"SELECT id FROM forecasts WHERE streamer_id=? AND active=1 AND stale=0 AND source='manual' AND predicted_start_at>? LIMIT 1",&[&sid,&now()])?;
    if !manual.is_null() && source != "manual" { return Ok(strv(&manual,"id").to_owned()); }
    let normalized = date.to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
    let old = one(db,"SELECT id,predicted_start_at,source,stale FROM forecasts WHERE streamer_id=? AND active=1 ORDER BY created_at DESC LIMIT 1",&[&sid])?;
    if strv(&old,"predicted_start_at") == normalized && strv(&old,"source") == source && number(&old,"stale",0)==0 { return Ok(strv(&old,"id").to_owned()); }
    let fid = id(); db.execute("UPDATE forecasts SET active=0 WHERE streamer_id=? AND active=1",[sid])?;
    db.execute("INSERT INTO forecasts(id,streamer_id,predicted_start_at,confidence,source,reason,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?)",params![fid,sid,normalized,confidence,source,reason,evidence.to_string(),now()])?;
    Ok(fid)
}
pub fn refresh_forecast(db: &Connection, sid: &str) -> Result<Option<String>> {
    let streamer = one(db,"SELECT timezone FROM streamers WHERE id=?",&[&sid])?;
    if streamer.is_null() || strv(&one(db,"SELECT status FROM live_state WHERE streamer_id=?",&[&sid])?,"status")=="live" { return Ok(None); }
    let zone = strv(&streamer,"timezone"); let timestamp = now(); let upper = after(8*86400);
    let today = time::local_date(&timestamp,zone)?;
    let exceptions = rows(db,"SELECT * FROM schedule_exceptions WHERE streamer_id=? AND occurrence_date>=? AND occurrence_date<=? ORDER BY occurrence_date,updated_at LIMIT 150",&[&sid,&today.to_string(),&(today+Duration::days(8)).to_string()],150)?;
    let rules = rows(db,"SELECT * FROM schedule_rules WHERE streamer_id=? AND active=1 ORDER BY weekday,local_time LIMIT 100",&[&sid],100)?;
    let events = rows(db,"SELECT * FROM timeline_events WHERE streamer_id=? AND active=1 AND planned_start_at>? AND planned_start_at<=? AND event_type IN ('scheduled','delayed','additional','cancelled') ORDER BY planned_start_at LIMIT 150",&[&sid,&timestamp,&upper],150)?;
    let mut candidates: Vec<(String,String,String,i64,Value)> = Vec::new();
    for offset in 0..=8 {
        let date = today+Duration::days(offset); let ds = date.to_string();
        let day_replaced = exceptions.iter().any(|e| strv(e,"occurrence_date")==ds && (strv(e,"status")!="cancelled" || e["start_at"].is_null()));
        if day_replaced { continue; }
        for rule in &rules {
            if number(rule,"weekday",0) != date.weekday().number_from_monday() as i64 { continue; }
            if rule["effective_from"].as_str().is_some_and(|s|s>ds.as_str()) || rule["effective_to"].as_str().is_some_and(|s|s<ds.as_str()) { continue; }
            if let Ok(start) = time::local_instant(&ds,strv(rule,"local_time"),zone) {
                candidates.push((start,"weekly_schedule".into(),strv(rule,"title").into(),number(rule,"confidence",70),json!([{"type":"schedule_rule","id":rule["id"]}])));
            }
        }
    }
    for entry in &exceptions {
        if ["scheduled","delayed"].contains(&strv(entry,"status")) {
            candidates.push((strv(entry,"start_at").into(),"schedule_confirmed".into(),strv(entry,"title").into(),number(entry,"confidence",90),json!([{"type":"schedule_exception","id":entry["id"]}])));
        }
    }
    for event in &events {
        if strv(event,"event_type") != "cancelled" {
            candidates.push((strv(event,"planned_start_at").into(),"dynamic".into(),strv(event,"title").into(),number(event,"confidence",80),json!([{"type":"timeline_event","id":event["id"]}])));
        }
    }
    candidates.retain(|candidate| candidate.0>timestamp && candidate.0<=upper &&
        !events.iter().any(|e|strv(e,"event_type")=="cancelled" && strv(e,"planned_start_at")==candidate.0) &&
        !exceptions.iter().any(|e|strv(e,"status")=="cancelled" && (strv(e,"start_at")==candidate.0 || (e["start_at"].is_null() && time::local_date(&candidate.0,zone).is_ok_and(|d|d.to_string()==strv(e,"occurrence_date"))))));
    fn priority(source: &str) -> u8 { match source { "dynamic"=>3,"schedule_confirmed"=>2,_=>1 } }
    candidates.sort_by(|a,b|a.0.cmp(&b.0).then_with(||priority(&b.1).cmp(&priority(&a.1))));
    if let Some((start,source,reason,confidence,evidence)) = candidates.into_iter().next() {
        return set_forecast(db,sid,&start,&source,&reason,confidence,evidence).map(Some);
    }
    // Absence of a replacement does not make the cancelled old forecast valid.
    db.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source IN ('weekly_schedule','schedule_confirmed','dynamic')",[sid])?;
    Ok(None)
}
pub fn replace_rules(db: &mut Connection, sid: &str, entries: &[Value], actor: &str) -> Result<()> {
    if entries.len()>70 { bail!("at most 70 rules"); }
    for entry in entries {
        if !(1..=7).contains(&number(entry,"weekday",0)) { bail!("invalid weekday"); }
        chrono::NaiveTime::parse_from_str(required(entry,"localTime",5)?,"%H:%M")?;
    }
    let tx = db.savepoint()?;
    tx.execute("UPDATE schedule_rules SET active=0,updated_at=? WHERE streamer_id=? AND source='manual'",params![now(),sid])?;
    for entry in entries { tx.execute("INSERT INTO schedule_rules(id,streamer_id,weekday,local_time,title,source,confidence,locked,created_at,updated_at) VALUES(?,?,?,?,?,'manual',100,1,?,?)",params![id(),sid,number(entry,"weekday",0),strv(entry,"localTime"),strv(entry,"title"),now(),now()])?; }
    tx.execute("UPDATE forecasts SET stale=1 WHERE streamer_id=? AND active=1 AND source='weekly_schedule'",[sid])?;
    audit(&tx,actor,"schedule.replace","streamer",sid,json!({"count":entries.len()}))?;
    refresh_forecast(&tx,sid)?; tx.commit()?; Ok(())
}
pub fn confirm_draft(db: &mut Connection, draft_id: &str, monday: Option<&str>, actor: &str) -> Result<usize> {
    let draft = one(db,"SELECT sd.*,s.timezone,d.content_hash AS current_hash FROM schedule_drafts sd JOIN streamers s ON s.id=sd.streamer_id JOIN dynamics d ON d.id=sd.dynamic_id WHERE sd.id=?",&[&draft_id])?;
    if draft.is_null() { bail!("NOT_FOUND: draft"); }
    if strv(&draft,"content_hash") != strv(&draft,"current_hash") { bail!("CONFLICT: source edited; review latest version"); }
    let entries: Vec<time::Entry> = serde_json::from_str(strv(&draft,"entries_json"))?;
    if strv(&draft,"status")=="confirmed" { return Ok(entries.len()); }
    if strv(&draft,"status")=="rejected" { bail!("rejected draft"); }
    let dates = time::validate_entries(&entries,monday,strv(&draft,"timezone"))?;
    let tx = db.savepoint()?;
    for (index,(entry,(date,start))) in entries.iter().zip(dates).enumerate() {
        tx.execute("INSERT INTO schedule_exceptions(id,streamer_id,occurrence_date,start_at,status,title,source,source_ref,confidence,locked,created_at,updated_at) VALUES(?,?,?,?,?,?,'schedule_confirmed',?,?,1,?,?) ON CONFLICT(streamer_id,occurrence_date,source_ref) DO UPDATE SET start_at=excluded.start_at,status=excluded.status,title=excluded.title,version=schedule_exceptions.version+1,updated_at=excluded.updated_at",params![id(),strv(&draft,"streamer_id"),date,start,entry.status,entry.title,format!("schedule-draft:{draft_id}:{index}"),entry.confidence,now(),now()])?;
    }
    tx.execute("UPDATE schedule_drafts SET status='confirmed',reviewed_at=?,reviewed_by=?,updated_at=? WHERE id=?",params![now(),actor,now(),draft_id])?;
    audit(&tx,actor,"schedule.confirm","schedule_draft",draft_id,json!({"count":entries.len()}))?;
    refresh_forecast(&tx,strv(&draft,"streamer_id"))?; tx.commit()?; Ok(entries.len())
}
pub fn update_live(db: &mut Connection, sid: &str, status: &str, title: &str) -> Result<()> {
    // Keep the legacy public enum even when an upstream adapter says "loop".
    let status = if status=="loop" { "rotating" } else { status };
    if !["live","offline","rotating"].contains(&status) { bail!("unknown is not an offline observation"); }
    let previous = one(db,"SELECT * FROM live_state WHERE streamer_id=?",&[&sid])?;
    let changed = strv(&previous,"status") != status; let timestamp = now(); let tx = db.savepoint()?;
    tx.execute("INSERT INTO live_state(streamer_id,status,title,checked_at,changed_at) VALUES(?,?,?,?,?) ON CONFLICT(streamer_id) DO UPDATE SET status=excluded.status,title=excluded.title,checked_at=excluded.checked_at,changed_at=CASE WHEN live_state.status!=excluded.status THEN excluded.changed_at ELSE live_state.changed_at END",params![sid,status,title,timestamp,timestamp])?;
    if changed && status=="live" {
        let session = id();
        tx.execute("INSERT INTO live_sessions(id,streamer_id,title,observed_start_at,created_at) VALUES(?,?,?,?,?)",params![session,sid,title,timestamp,timestamp])?;
        tx.execute("INSERT INTO rs_observations VALUES(?,?,?,?,?)",params![session,sid,if strv(&previous,"status")=="unknown" { None } else { previous["checked_at"].as_str() },timestamp,"live_started"])?;
        tx.execute("INSERT INTO timeline_events(id,streamer_id,event_type,occurred_at,source_type,source_id,title,confidence,event_key,created_at,updated_at) VALUES(?,?,'live_started',?,'live_session',?,?,100,?,?,?)",params![id(),sid,timestamp,session,title,format!("live-start:{session}"),timestamp,timestamp])?;
        if strv(&previous,"status") != "unknown" {
            let forecast = one(&tx,"SELECT * FROM forecasts WHERE streamer_id=? AND created_at<=? AND predicted_start_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 1",&[&sid,&after(-600),&after(-21600),&after(21600)])?;
            if !forecast.is_null() {
                let start = chrono::DateTime::parse_from_rfc3339(strv(&forecast,"predicted_start_at"))?;
                let error = (Utc::now()-start.with_timezone(&Utc)).num_seconds() as f64/60.0;
                tx.execute("INSERT OR IGNORE INTO prediction_evaluations(id,streamer_id,forecast_id,live_session_id,outcome,predicted_start_at,actual_start_at,error_minutes,source,within_30,within_60,created_at) VALUES(?,?,?,?,'evaluated',?,?,?,?,?,?,?)",params![id(),sid,strv(&forecast,"id"),session,strv(&forecast,"predicted_start_at"),timestamp,error,strv(&forecast,"source"),(error.abs()<=30.0) as i64,(error.abs()<=60.0) as i64,timestamp])?;
            } else {
                tx.execute("INSERT OR IGNORE INTO prediction_evaluations(id,streamer_id,live_session_id,outcome,actual_start_at,created_at) VALUES(?,?,?,'missed',?,?)",params![id(),sid,session,timestamp,timestamp])?;
            }
        }
    }
    if changed && status!="live" && strv(&previous,"status")=="live" {
        let session = one(&tx,"SELECT id FROM live_sessions WHERE streamer_id=? AND observed_end_at IS NULL ORDER BY observed_start_at DESC LIMIT 1",&[&sid])?;
        tx.execute("UPDATE live_sessions SET observed_end_at=? WHERE streamer_id=? AND observed_end_at IS NULL",params![timestamp,sid])?;
        if !session.is_null() { tx.execute("INSERT OR IGNORE INTO timeline_events(id,streamer_id,event_type,occurred_at,source_type,source_id,title,confidence,event_key,created_at,updated_at) VALUES(?,?,'live_ended',?,'live_session',?,?,100,?,?,?)",params![id(),sid,timestamp,strv(&session,"id"),title,format!("live-end:{}",strv(&session,"id")),timestamp,timestamp])?; }
        refresh_forecast(&tx,sid)?;
    }
    tx.commit()?; Ok(())
}
