use anyhow::{bail, Context, Result};
use chrono::{Duration as ChronoDuration,Utc};
use futures_util::StreamExt;
use rusqlite::params;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,sync::Arc,time::Duration};
use tokio::io::AsyncWriteExt;
use crate::{business,db::{self,*},limits,security,upstream::{self,Bili},App};

pub async fn run(app:Arc<App>){
    let owner=id();let mut ticks=0u64;
    loop{
        if app.stopping.load(std::sync::atomic::Ordering::Relaxed){break;}
        if ticks%15==0{if let Err(e)=enqueue_due(&app).await{eprintln!("enqueue: {e}");}}
        let token=owner.clone();let job=app.db.call(move|db|claim(db,&token)).await;
        if let Ok(job)=job{if !job.is_null(){
            let jid=strv(&job,"id").to_owned();let heartbeat_id=jid.clone();let heartbeat_owner=owner.clone();let heartbeat_db=app.db.clone();
            let heartbeat=tokio::spawn(async move{loop{tokio::time::sleep(Duration::from_secs(30)).await;let jid=heartbeat_id.clone();let owner=heartbeat_owner.clone();let _=heartbeat_db.call(move|db|{db.execute("UPDATE jobs SET lease_until=? WHERE id=? AND lease_owner=?",params![after(180),jid,owner])?;Ok(())}).await;}});
            let result=tokio::time::timeout(Duration::from_secs(125),execute(&app,&job)).await;
            heartbeat.abort();let error=match result{Ok(Ok(()))=>None,Ok(Err(e))=>Some(e.to_string()),Err(_)=>Some("task deadline; resume from durable cursor".into())};
            let token=owner.clone();let attempts=number(&job,"attempts",0);let deferred=error.as_ref().is_some_and(|e|e.starts_with("BUSY:")||e.starts_with("COOLDOWN:")||e.starts_with("DEPENDENCY:"));
            let delay=if error.as_ref().is_some_and(|e|e.starts_with("COOLDOWN:")){3600}else if deferred{30}else{(5_i64*2_i64.pow(attempts.min(8) as u32)).min(3600)};
            let copy=error.clone();let _=app.db.call(move|db|{
                if deferred{db.execute("UPDATE jobs SET attempts=MAX(0,attempts-1) WHERE id=? AND lease_owner=?",params![jid,token])?;}
                finish(db,&jid,&token,copy.as_deref(),delay)
            }).await;
            if let Some(e)=error{eprintln!("job {}: {}",strv(&job,"type"),e.chars().take(400).collect::<String>());}
        }}
        ticks+=1;tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
async fn enqueue_due(app:&Arc<App>)->Result<()>{
    app.db.call(|db|{
        let due=rows(db,"SELECT s.id FROM streamers s WHERE enabled=1 AND (last_dynamic_sync_at IS NULL OR (julianday('now')-julianday(last_dynamic_sync_at))*86400>=dynamic_poll_seconds) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.entity_id=s.id AND j.type='sync_streamer' AND j.status IN ('pending','retry','running')) ORDER BY COALESCE(last_dynamic_sync_at,'') LIMIT 20",&[],20)?;
        for s in due{let sid=strv(&s,"id");enqueue(db,"sync_streamer",sid,json!({}),20,0,&format!("periodic:{sid}:{}",Utc::now().timestamp()/60))?;}
        db.execute("UPDATE forecasts SET stale=1 WHERE active=1 AND stale=0 AND predicted_start_at<=?",[now()])?;
        let day=Utc::now().timestamp()/86400;enqueue(db,"cleanup_storage","",json!({}),95,0,&format!("cleanup:{day}"))?;
        Ok(())
    }).await
}
pub async fn live_loop(app:Arc<App>){
    loop{
        if app.stopping.load(std::sync::atomic::Ordering::Relaxed){break;}
        if let Err(e)=poll_live(&app).await{eprintln!("live poll: {}",e.to_string().chars().take(200).collect::<String>());tokio::time::sleep(Duration::from_secs(if e.to_string().starts_with("COOLDOWN:"){60}else{30})).await;}
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
async fn poll_live(app:&Arc<App>)->Result<()>{
    let targets=app.db.call(|db|rows(db,"SELECT s.id,s.bili_uid,s.room_id,s.resolved_room_id,ls.checked_at FROM streamers s LEFT JOIN live_state ls ON ls.streamer_id=s.id WHERE s.enabled=1 AND (ls.checked_at IS NULL OR (julianday('now')-julianday(ls.checked_at))*86400>=s.live_poll_seconds) ORDER BY COALESCE(ls.checked_at,'') LIMIT 50",&[],50)).await?;
    if targets.is_empty(){return Ok(());}
    let mut url=url::Url::parse("https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids")?;
    for target in &targets{url.query_pairs_mut().append_pair("uids[]",strv(target,"bili_uid"));}
    let states=app.bili.json(url.as_str()).await?;
    for target in targets{
        let uid=strv(&target,"bili_uid");let mut state=states[uid].clone();
        if state.is_null(){continue;}
        let candidate_uid=upstream::id_string(&state["uid"]);
        if candidate_uid!=uid{continue;}
        let sid=strv(&target,"id").to_owned();let configured=strv(&target,"room_id");let rid=upstream::id_string(&state["room_id"]);let short=upstream::id_string(&state["short_id"]);
        if configured!=rid && configured!=short && strv(&target,"resolved_room_id")!=rid{
            let init=app.bili.json(&format!("https://api.live.bilibili.com/room/v1/Room/room_init?id={configured}")).await?;
            if upstream::id_string(&init["uid"])!=uid{let sid=sid.clone();app.db.call(move|db|{db.execute("UPDATE streamers SET room_mapping_status='conflict',room_mapping_checked_at=? WHERE id=?",params![now(),sid])?;Ok(())}).await?;continue;}
            state["room_id"]=init["room_id"].clone();
        }
        let status=match number(&state,"live_status",0){1=>"live",2=>"loop",_=>"offline"};let title=strv(&state,"title").to_owned();let resolved=upstream::id_string(&state["room_id"]);
        app.db.call(move|db|{db.execute("UPDATE streamers SET resolved_room_id=?,room_short_id=?,room_mapping_status='verified',room_mapping_checked_at=? WHERE id=?",params![resolved,short,now(),sid])?;business::update_live(db,&sid,status,&title)}).await?;
    }Ok(())
}
async fn execute(app:&Arc<App>,job:&Value)->Result<()>{
    if let Some(bridge) = &app.bridge {
        if ["rs_analyze_dynamic", "pi_analyze", "pi_revision", "recognize_schedule"].contains(&strv(job, "type")) {
            return bridge.run_job(app, job).await;
        }
    }
    let entity=strv(job,"entity_id");let payload:Value=serde_json::from_str(strv(job,"payload_json")).unwrap_or(json!({}));
    match strv(job,"type"){
        "sync_streamer"=>sync_streamer(app,entity,payload).await,
        "refresh_dynamic"=>refresh_dynamic(app,entity).await,
        "sync_comments"=>sync_comments(app,entity,payload).await,
        "sync_sub_replies"=>sync_replies(app,payload).await,
        "download_media"=>download(app,entity).await,
        "rs_analyze_dynamic"=>crate::ai::analyze_dynamic(app,entity).await,
        "pi_analyze"=>{let sid=entity.to_owned();app.db.call(move|db|{let items=rows(db,"SELECT id,content_hash FROM dynamics WHERE streamer_id=? AND state='visible' AND (is_pinned=1 OR published_at>=?) ORDER BY is_pinned DESC,published_at DESC LIMIT 30",&[&sid,&after(-14*86400)],30)?;for d in items{enqueue(db,"rs_analyze_dynamic",strv(&d,"id"),json!({}),35,0,&format!("manual-analysis:{}:{}",d["id"],id()))?;}Ok(())}).await},
        "pi_revision"=>{let rid=entity.to_owned();let d=app.db.call(move|db|one(db,"SELECT dynamic_id FROM dynamic_revisions WHERE id=?",&[&rid])).await?;if !d.is_null(){crate::ai::analyze_dynamic(app,strv(&d,"dynamic_id")).await?;}Ok(())},
        "recognize_schedule"=>{let did=entity.to_owned();let d=app.db.call(move|db|one(db,"SELECT dynamic_id FROM schedule_drafts WHERE id=?",&[&did])).await?;if !d.is_null(){crate::ai::analyze_dynamic(app,strv(&d,"dynamic_id")).await?;}Ok(())},
        "validate_cookie"=>{let data=app.bili.json("https://api.bilibili.com/x/web-interface/nav").await?;if data["isLogin"]!=true{bail!("cookie is not logged in");}Ok(())},
        "repair_dynamic_archives"=>{app.db.call(|db|{let list=rows(db,"SELECT id FROM dynamics WHERE state='visible' AND text='' AND content_quality!='detail' LIMIT 10",&[],10)?;for d in list{enqueue(db,"refresh_dynamic",strv(&d,"id"),json!({}),70,0,&format!("repair:{}:{}",d["id"],Utc::now().timestamp()/86400))?;}Ok(())}).await},
        "cleanup_storage"=>cleanup(app).await,
        "send_alert_email"=>crate::mail::send(app,entity).await,
        other=>bail!("unsupported legacy job type {other}; retained as failed, not discarded"),
    }
}
async fn sync_streamer(app:&Arc<App>,sid:&str,mut payload:Value)->Result<()>{
    let sid_owned=sid.to_owned();let streamer=app.db.call(move|db|one(db,"SELECT * FROM streamers WHERE id=? AND enabled=1",&[&sid_owned])).await?;
    if streamer.is_null(){return Ok(());}
    let full=payload["fullSync"].as_bool().unwrap_or(false);let scan=payload["scanId"].as_str().map(String::from).unwrap_or_else(id);
    let since=payload["since"].as_str().map(String::from).unwrap_or_else(||(Utc::now()-ChronoDuration::days(183)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true));
    let mut url=url::Url::parse("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space")?;
    url.query_pairs_mut().append_pair("host_mid",strv(&streamer,"bili_uid")).append_pair("timezone_offset","-480").append_pair("features","itemOpusStyle").append_pair("platform","web");
    if let Some(offset)=payload["offset"].as_str(){url.query_pairs_mut().append_pair("offset",offset);}
    let feed=app.bili.json(url.as_str()).await?;let items=feed["items"].as_array().context("feed missing items; not a complete scan")?;
    if items.len()>100{bail!("feed page exceeds item budget");}
    let mut all_old=!items.is_empty();
    for item in items{
        if strv(item,"type")=="DYNAMIC_TYPE_LIVE_RCMD"{continue;}
        let mut dynamic=upstream::normalize_dynamic(item)?;
        if strv(&dynamic,"publishedAt")>=since.as_str(){all_old=false;}
        if full && strv(&dynamic,"publishedAt")<since.as_str() && dynamic["isPinned"]!=true{continue;}
        if dynamic["detailRequired"]==true{
            let detail=app.bili.detail(strv(&dynamic,"id")).await?;
            if !strv(&detail,"text").is_empty(){dynamic["text"]=detail["text"].clone();}
            if detail["mediaUrls"].as_array().is_some_and(|a|!a.is_empty()){dynamic["mediaUrls"]=detail["mediaUrls"].clone();}
            dynamic["raw"]["emojiMap"]=detail["emojiMap"].clone();
        }
        let sid=sid.to_owned();let scan=scan.clone();app.db.call(move|db|{business::upsert_dynamic(db,&sid,&dynamic)?;db.execute("INSERT OR IGNORE INTO rs_scan_items VALUES(?,?)",params![scan,strv(&dynamic,"id")])?;Ok(())}).await?;
    }
    let offset=strv(&feed,"offset").to_owned();let more=feed["has_more"].as_bool().unwrap_or(false);
    if full && more && !all_old && !offset.is_empty(){
        if payload["offset"].as_str()==Some(&offset){bail!("feed cursor did not advance; deletion not inferred");}
        payload["offset"]=json!(offset);payload["scanId"]=json!(scan);payload["since"]=json!(since);
        let sid=sid.to_owned();app.db.call(move|db|{enqueue(db,"sync_streamer",&sid,payload,60,5,&format!("full:{sid}:{scan}:{}",security::digest(offset)))?;Ok(())}).await?;
    }else{
        let sid=sid.to_owned();app.db.call(move|db|{
            let tx=db.transaction()?;
            if full{tx.execute("UPDATE dynamics SET missing_complete_scans=missing_complete_scans+1,last_missing_scan_id=?,state=CASE WHEN missing_complete_scans>=1 THEN 'deleted' ELSE 'suspected_deleted' END WHERE streamer_id=? AND published_at>=? AND state IN ('visible','suspected_deleted') AND COALESCE(last_missing_scan_id,'')!=? AND NOT EXISTS(SELECT 1 FROM rs_scan_items WHERE scan_id=? AND item_id=dynamics.id)",params![scan,sid,since,scan,scan])?;
                tx.execute("UPDATE streamers SET dynamic_history_initialized_at=COALESCE(dynamic_history_initialized_at,?),last_dynamic_full_sync_at=? WHERE id=?",params![now(),now(),sid])?;}
            tx.execute("UPDATE streamers SET last_dynamic_sync_at=?,updated_at=? WHERE id=?",params![now(),now(),sid])?;
            tx.execute("DELETE FROM rs_scan_items WHERE scan_id=?",[scan])?;tx.commit()?;Ok(())
        }).await?;
    }Ok(())
}
async fn refresh_dynamic(app:&Arc<App>,did:&str)->Result<()>{
    let did_owned=did.to_owned();let old=app.db.call(move|db|one(db,"SELECT * FROM dynamics WHERE id=?",&[&did_owned])).await?;
    if old.is_null(){return Ok(());}
    let mut detail=app.bili.detail(did).await?;detail["id"]=json!(did);detail["publishedAt"]=old["published_at"].clone();detail["type"]=old["type"].clone();detail["raw"]=serde_json::from_str(strv(&old,"raw_excerpt")).unwrap_or(json!({}));
    let sid=strv(&old,"streamer_id").to_owned();app.db.call(move|db|{business::upsert_dynamic(db,&sid,&detail)?;db.execute("UPDATE dynamics SET content_quality='detail',detail_fetched_at=? WHERE id=?",params![now(),strv(&detail,"id")])?;Ok(())}).await
}
async fn sync_comments(app:&Arc<App>,did:&str,mut payload:Value)->Result<()>{
    let key=did.to_owned();let dynamic=app.db.call(move|db|one(db,"SELECT d.*,s.bili_uid,s.enabled FROM dynamics d JOIN streamers s ON s.id=d.streamer_id WHERE d.id=?",&[&key])).await?;
    if dynamic.is_null() || number(&dynamic,"enabled",0)==0{return Ok(());}
    let mut oid=strv(&dynamic,"comment_oid").to_owned();let mut kind=strv(&dynamic,"comment_type").to_owned();
    if oid.is_empty()||kind.is_empty(){let detail=app.bili.detail(did).await?;oid=strv(&detail,"commentOid").into();kind=strv(&detail,"commentType").into();}
    if oid.is_empty()||kind.is_empty(){bail!("comment identity unavailable");}
    let scan=payload["scanId"].as_str().map(String::from).unwrap_or_else(id);
    let mut args=BTreeMap::from([("oid".into(),oid.clone()),("type".into(),kind.clone()),("mode".into(),"2".into()),("plat".into(),"1".into()),("web_location".into(),"1315875".into())]);
    if let Some(offset)=payload["offset"].as_str(){args.insert("pagination_str".into(),json!({"offset":offset}).to_string());}
    let page=app.bili.signed("/x/v2/reply/wbi/main",args).await?;
    let mut replies=page["replies"].as_array().cloned().unwrap_or_default();
    if let Some(tops)=page["top_replies"].as_array(){replies.extend(tops.iter().cloned());}
    if let Some(top)=page["top"]["upper"].as_object(){replies.push(Value::Object(top.clone()));}
    if replies.len()>100{bail!("comment page exceeds item budget");}
    for reply in replies{
        let comment=upstream::normalize_comment(&reply,None);let did=did.to_owned();let uid=strv(&dynamic,"bili_uid").to_owned();let scan=scan.clone();let oid=oid.clone();let kind=kind.clone();
        app.db.call(move|db|{business::upsert_comment(db,&did,&comment,&uid)?;db.execute("INSERT OR IGNORE INTO rs_scan_items VALUES(?,?)",params![scan,strv(&comment,"id")])?;
            if number(&comment,"replyCount",0)>0{enqueue(db,"sync_sub_replies",&did,json!({"dynamicId":did,"oid":oid,"type":kind,"rootId":comment["id"],"streamerUid":uid,"startPage":1,"totalPages":(number(&comment,"replyCount",0)+19)/20,"scanId":format!("sub:{scan}:{}",comment["id"])}),60,2,&format!("sub:{scan}:{}",comment["id"]))?;}Ok(())}).await?;
    }
    let offset=page["cursor"]["pagination_reply"]["next_offset"].as_str().unwrap_or("").to_owned();let complete=page["cursor"]["is_end"].as_bool().unwrap_or(false);
    if !complete && offset.is_empty(){bail!("missing comment continuation cursor; not a completed scan");}
    let did=did.to_owned();let sid=strv(&dynamic,"streamer_id").to_owned();
    if complete{app.db.call(move|db|{db.execute("UPDATE comments SET state='unavailable',updated_at=? WHERE dynamic_id=? AND root_id IS NULL AND NOT EXISTS(SELECT 1 FROM rs_scan_items WHERE scan_id=? AND item_id=comments.id)",params![now(),did,scan])?;
        db.execute("DELETE FROM rs_scan_items WHERE scan_id=?",[scan])?;db.execute("UPDATE comment_sync_state SET offset=NULL,is_complete=1,last_full_sync_at=?,next_sync_at=?,updated_at=? WHERE dynamic_id=?",params![now(),after(3600),now(),did])?;db.execute("UPDATE streamers SET last_comment_sync_at=? WHERE id=?",params![now(),sid])?;enqueue(db,"sync_comments",&did,json!({}),90,3600,&format!("comments:{did}:{}",Utc::now().timestamp()/3600+1))?;Ok(())}).await?;}
    else{if payload["offset"].as_str()==Some(offset.as_str()){bail!("comment cursor stalled");}payload["scanId"]=json!(scan);payload["offset"]=json!(offset);app.db.call(move|db|{db.execute("UPDATE comment_sync_state SET offset=?,is_complete=0,updated_at=? WHERE dynamic_id=?",params![offset,now(),did])?;enqueue(db,"sync_comments",&did,payload,55,5,&format!("comments:{scan}:{}",security::digest(offset)))?;Ok(())}).await?;}
    Ok(())
}
async fn sync_replies(app:&Arc<App>,mut p:Value)->Result<()>{
    let page=number(&p,"startPage",1);let args=BTreeMap::from([("oid".into(),strv(&p,"oid").into()),("type".into(),strv(&p,"type").into()),("root".into(),strv(&p,"rootId").into()),("pn".into(),page.to_string()),("ps".into(),"20".into())]);
    let result=app.bili.signed("/x/v2/reply/reply",args).await?;let replies=result["replies"].as_array().cloned().unwrap_or_default();
    if replies.len()>100{bail!("reply page exceeds budget");}
    let did=strv(&p,"dynamicId").to_owned();let root=strv(&p,"rootId").to_owned();let uid=strv(&p,"streamerUid").to_owned();let scan=strv(&p,"scanId").to_owned();
    let records:Vec<Value>=replies.iter().map(|r|upstream::normalize_comment(r,Some(&root))).collect();let did2=did.clone();let scan2=scan.clone();
    app.db.call(move|db|{for c in records{business::upsert_comment(db,&did2,&c,&uid)?;db.execute("INSERT OR IGNORE INTO rs_scan_items VALUES(?,?)",params![scan2,strv(&c,"id")])?;}Ok(())}).await?;
    if page<number(&p,"totalPages",page) && !replies.is_empty(){p["startPage"]=json!(page+1);app.db.call(move|db|{enqueue(db,"sync_sub_replies",&did,p,60,5,&format!("sub:{scan}:{}",page+1))?;Ok(())}).await?;}
    else{app.db.call(move|db|{db.execute("UPDATE comments SET state='unavailable',updated_at=? WHERE dynamic_id=? AND root_id=? AND NOT EXISTS(SELECT 1 FROM rs_scan_items WHERE scan_id=? AND item_id=comments.id)",params![now(),did,root,scan])?;db.execute("DELETE FROM rs_scan_items WHERE scan_id=?",[scan])?;Ok(())}).await?;}Ok(())
}
async fn download(app:&Arc<App>,mid:&str)->Result<()>{
    let key=mid.to_owned();let record=app.db.call(move|db|one(db,"SELECT * FROM media_assets WHERE id=?",&[&key])).await?;if record.is_null()||strv(&record,"state")=="stored"{return Ok(());}
    let mut url=url::Url::parse(strv(&record,"source_url"))?;let host=url.host_str().unwrap_or("");
    if !(host=="hdslb.com"||host.ends_with(".hdslb.com")){bail!("untrusted media host");}url.set_scheme("https").map_err(|_|anyhow::anyhow!("invalid media URL"))?;
    if let Some(mock)=&app.bili.mock_origin{url=url::Url::parse(&format!("{mock}{}",url.path()))?;}
    let used=app.db.call(|db|Ok(db.query_row("SELECT COALESCE(SUM(byte_size),0) FROM media_assets WHERE state='stored'",[],|r|r.get::<_,i64>(0))?)).await?;
    if used>=app.media_quota as i64{let mid=mid.to_owned();app.db.call(move|db|{db.execute("UPDATE media_assets SET state='quota_exceeded',error='media quota',updated_at=? WHERE id=?",params![now(),mid])?;Ok(())}).await?;return Ok(());}
    let response=app.client.get(url).header("referer","https://www.bilibili.com/").send().await?;
    if !response.status().is_success(){bail!("media HTTP {}",response.status());}
    if response.content_length().is_some_and(|n|n>limits::MEDIA_LIMIT as u64){bail!("media exceeds size budget");}
    let temp=app.media_dir.join(".tmp");tokio::fs::create_dir_all(&temp).await?;let temp=temp.join(format!("{}.part",id()));
    let outcome=async{
        let mut output=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temp).await?;
        let mut stream=response.bytes_stream();let mut bytes=0usize;let mut hash=Sha256::new();let mut prefix=Vec::new();
        while let Some(chunk)=stream.next().await{let chunk=chunk?;bytes+=chunk.len();if bytes>limits::MEDIA_LIMIT || used+bytes as i64>app.media_quota as i64{bail!("media byte/quota limit");}if prefix.len()<32{prefix.extend_from_slice(&chunk[..chunk.len().min(32-prefix.len())]);}hash.update(&chunk);output.write_all(&chunk).await?;}
        output.flush().await?;output.sync_data().await?;drop(output);
        let (mime,ext)=sniff(&prefix).context("unsupported image signature")?;let hash=hex::encode(hash.finalize());let relative=format!("{}/{}.{}",&hash[..2],hash,ext);let final_path=app.media_dir.join(&relative);tokio::fs::create_dir_all(final_path.parent().unwrap()).await?;tokio::fs::rename(&temp,&final_path).await?;
        let mid=mid.to_owned();let source=strv(&record,"source_url").to_owned();
        app.db.call(move|db|{
            let tx=db.transaction()?;let existing=one(&tx,"SELECT id FROM media_assets WHERE sha256=? AND state='stored' LIMIT 1",&[&hash])?;
            if !existing.is_null() && strv(&existing,"id")!=mid{
                let target=strv(&existing,"id");
                for (table,column) in [("dynamic_media","dynamic_id"),("comment_media","comment_id")]{tx.execute(&format!("INSERT OR IGNORE INTO {table}({column},media_id,position,source_url) SELECT {column},?,position,source_url FROM {table} WHERE media_id=?"),params![target,mid])?;tx.execute(&format!("DELETE FROM {table} WHERE media_id=?"),[&mid])?;}
                tx.execute("INSERT OR IGNORE INTO rs_media_refs SELECT owner_type,owner_id,? FROM rs_media_refs WHERE media_id=?",params![target,mid])?;tx.execute("DELETE FROM rs_media_refs WHERE media_id=?",[&mid])?;
                tx.execute("INSERT INTO media_source_aliases VALUES(?,?,?) ON CONFLICT(source_url) DO UPDATE SET media_id=excluded.media_id",params![source,target,now()])?;tx.execute("DELETE FROM media_assets WHERE id=?",[&mid])?;
            }else{tx.execute("UPDATE media_assets SET sha256=?,local_path=?,mime_type=?,byte_size=?,state='stored',error=NULL,updated_at=? WHERE id=?",params![hash,relative,mime,bytes as i64,now(),mid])?;}
            tx.commit()?;Ok(())
        }).await?;Ok::<(),anyhow::Error>(())
    }.await;
    if outcome.is_err(){let _=tokio::fs::remove_file(&temp).await;}
    outcome
}
fn sniff(b:&[u8])->Option<(&'static str,&'static str)>{
    if b.starts_with(b"\x89PNG\r\n\x1a\n"){Some(("image/png","png"))}else if b.starts_with(b"\xff\xd8\xff"){Some(("image/jpeg","jpg"))}else if b.starts_with(b"GIF87a")||b.starts_with(b"GIF89a"){Some(("image/gif","gif"))}else if b.len()>=12 && &b[..4]==b"RIFF" && &b[8..12]==b"WEBP"{Some(("image/webp","webp"))}else if b.len()>=12 && &b[4..8]==b"ftyp" && [&b"avif"[..],&b"avis"[..]].contains(&&b[8..12]){Some(("image/avif","avif"))}else{None}
}
async fn cleanup(app:&Arc<App>)->Result<()>{
    // Each statement removes at most 100 rows. No history/JSON/image table is materialized.
    app.db.call(|db|{
        for (table,where_clause) in [("jobs","status IN ('done','failed') AND updated_at<datetime('now','-30 days')"),("audit_log","created_at<datetime('now','-90 days')"),("ai_usage","created_at<datetime('now','-90 days')"),("pi_tool_runs","created_at<datetime('now','-90 days')")]{db.execute(&format!("DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE {where_clause} LIMIT 100)"),[])?;}
        db.execute("DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions WHERE expires_at<? LIMIT 100)",[now()])?;
        db.execute("DELETE FROM rs_content_cache WHERE cache_key IN (SELECT cache_key FROM rs_content_cache WHERE created_at<? LIMIT 100)",[after(-90*86400)])?;
        db.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }).await
}
