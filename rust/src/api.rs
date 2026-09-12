use anyhow::{bail, Context, Result};
use axum::{body::{Body,to_bytes},extract::{Path,State},http::{HeaderMap,Method,Request,StatusCode},response::{Html,IntoResponse,Response},routing::{any,get},Json,Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
use rusqlite::{params,Connection};
use serde_json::{json,Value};
use std::{collections::HashMap,sync::Arc};
use crate::{ai,business,db::*,limits,security,App};

pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/",get(index)).route("/app.js",get(script))
        .route("/healthz",get(||async{Json(json!({"status":"ok","runtime":"rust"}))}))
        .route("/api/v1/{*path}",any(dispatch)).route("/api/streamers",get(streamer_compat))
        .route("/media/{id}",get(local_media)).route("/api/image-proxy/{*path}",get(image_proxy))
        .fallback(index).with_state(app)
}
pub fn management_router(app: Arc<App>) -> Router {
    Router::new().route("/v1/{*path}",any(management_dispatch))
        .route("/v1/healthz",get(||async{Json(json!({"status":"ok"}))})).with_state(app)
}
async fn index() -> Response { let mut response=Html(include_str!("../web/index.html")).into_response(); security_headers(&mut response); response }
async fn script() -> Response { let mut response=Response::builder().header("content-type","text/javascript; charset=utf-8").header("cache-control","public, max-age=3600").body(Body::from(include_str!("../web/app.js"))).unwrap(); security_headers(&mut response); response }
fn security_headers(response: &mut Response) {
    response.headers_mut().insert("x-content-type-options","nosniff".parse().unwrap());
    response.headers_mut().insert("referrer-policy","no-referrer".parse().unwrap());
    response.headers_mut().insert("content-security-policy","default-src 'self'; img-src 'self' https://*.hdslb.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
}
fn error_response(error: anyhow::Error) -> Response {
    let message=error.to_string();
    let status=if message.starts_with("AUTH:"){401}else if message.starts_with("FORBIDDEN:"){403}else if message.starts_with("NOT_FOUND:"){404}else if message.starts_with("CONFLICT:"){409}else if message.starts_with("BUSY:")||message.starts_with("DEPENDENCY:"){503}else{400};
    let safe=if message.contains("SQL")||message.contains("sqlite"){ "database operation failed".to_owned() } else { message.chars().take(300).collect() };
    let mut response=(StatusCode::from_u16(status).unwrap(),Json(json!({"error":safe}))).into_response();
    response.headers_mut().insert("cache-control","no-store".parse().unwrap());
    if status==503 { response.headers_mut().insert("retry-after","2".parse().unwrap()); }
    response
}
#[derive(Clone)] struct Actor { id:String, scopes:Vec<String>, force:bool, session:bool }
impl Actor {
    fn scope(&self, scope: &str) -> Result<()> {
        if self.session || self.scopes.iter().any(|s|s==scope||s=="*") { Ok(()) } else { bail!("FORBIDDEN: missing scope {scope}") }
    }
}
fn cookie(headers: &HeaderMap) -> Option<String> {
    headers.get("cookie")?.to_str().ok()?.split(';').find_map(|part|part.trim().strip_prefix("vtbm_session=").map(String::from))
}
async fn actor(app: &Arc<App>, headers: &HeaderMap, management: bool) -> Result<Actor> {
    if let Some(token)=headers.get("authorization").and_then(|v|v.to_str().ok()).and_then(|s|s.strip_prefix("Bearer ")) {
        if token.len()>256 { bail!("AUTH: invalid bearer token"); }
        let hash=security::digest(token);
        return app.db.call(move|db|{
            let row=one(db,"SELECT id,scopes_json FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",&[&hash,&now()])?;
            if row.is_null() { bail!("AUTH: invalid bearer token"); }
            db.execute("UPDATE api_tokens SET last_used_at=? WHERE id=?",params![now(),strv(&row,"id")])?;
            Ok(Actor{id:strv(&row,"id").into(),scopes:serde_json::from_str(strv(&row,"scopes_json"))?,force:false,session:false})
        }).await;
    }
    if management { bail!("AUTH: management API requires bearer token"); }
    let token=cookie(headers).context("AUTH: login required")?;
    if token.len()>256 { bail!("AUTH: invalid session"); }
    let hash=security::digest(token);
    app.db.call(move|db|{
        let row=one(db,"SELECT a.id,a.force_password_change FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?",&[&hash,&now()])?;
        if row.is_null() { bail!("AUTH: session expired"); }
        Ok(Actor{id:strv(&row,"id").into(),scopes:vec![],force:number(&row,"force_password_change",1)==1,session:true})
    }).await
}
fn csrf(app: &App, headers: &HeaderMap) -> Result<()> {
    if headers.get("origin").and_then(|v|v.to_str().ok()).unwrap_or("") != app.origin { bail!("FORBIDDEN: request Origin does not match configured ORIGIN"); }
    Ok(())
}
async fn login(app: &Arc<App>, headers: &HeaderMap, body: &Value) -> Result<Response> {
    csrf(app,headers)?;
    let permit=app.expensive.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: authentication/AI work in progress"))?;
    let username=business::required(body,"username",100)?.to_owned(); let password=business::required(body,"password",1024)?.to_owned();
    let record=app.db.call(move|db|one(db,"SELECT id,password_hash,force_password_change FROM admins WHERE username=?",&[&username])).await?;
    let encoded=record["password_hash"].as_str().unwrap_or(&app.dummy_password_hash).to_owned();
    let valid=tokio::task::spawn_blocking(move||{let _permit=permit;security::verify_password(&password,&encoded)}).await??;
    if !valid||record.is_null() { tokio::time::sleep(std::time::Duration::from_millis(200)).await; bail!("AUTH: invalid credentials"); }
    let token=security::token("session"); let hash=security::digest(&token); let admin=strv(&record,"id").to_owned();
    app.db.call(move|db|{db.execute("INSERT INTO admin_sessions VALUES(?,?,?,?,?)",params![hash,admin,after(7*86400),now(),now()])?;Ok(())}).await?;
    let secure=if app.origin.starts_with("https://"){ "; Secure" }else{ "" };
    let mut response=Json(json!({"authenticated":true,"forcePasswordChange":record["force_password_change"]==1})).into_response();
    response.headers_mut().insert("set-cookie",format!("vtbm_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800{secure}").parse()?);
    Ok(response)
}
async fn dispatch(State(app): State<Arc<App>>, Path(path): Path<String>, request: Request<Body>) -> Response {
    match dispatch_inner(app,path,request,false).await { Ok(mut response)=>{security_headers(&mut response);response.headers_mut().insert("cache-control","no-store".parse().unwrap());response},Err(error)=>error_response(error) }
}
async fn management_dispatch(State(app): State<Arc<App>>, Path(path): Path<String>, request: Request<Body>) -> Response {
    match dispatch_inner(app,path,request,true).await { Ok(mut response)=>{response.headers_mut().insert("cache-control","no-store".parse().unwrap());response},Err(error)=>error_response(error) }
}
fn cursor(query: &HashMap<String,String>) -> Result<(String,String)> {
    if let Some(c)=query.get("cursor") {
        if c.len()>256 { bail!("invalid cursor"); }
        let parsed:Vec<String>=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(c)?)?;
        if parsed.len()!=2 { bail!("invalid cursor"); }
        Ok((parsed[0].clone(),parsed[1].clone()))
    } else { Ok(("9999".into(),"~".into())) }
}
fn page(mut data: Vec<Value>, limit: usize, time_key: &str) -> Value {
    let more=data.len()>limit; data.truncate(limit);
    let next=if more { data.last().map(|row|URL_SAFE_NO_PAD.encode(json!([row[time_key],row["id"]]).to_string())) } else { None };
    json!({"data":data,"nextCursor":next})
}
async fn dispatch_inner(app: Arc<App>, path: String, request: Request<Body>, management: bool) -> Result<Response> {
    let _request_permit=app.api_slots.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: API capacity reached"))?;
    let method=request.method().clone(); let headers=request.headers().clone();
    if ![Method::GET,Method::POST,Method::PATCH,Method::DELETE].contains(&method) { bail!("unsupported HTTP method"); }
    let query:HashMap<String,String>=url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).into_owned().collect();
    let parts:Vec<&str>=path.trim_matches('/').split('/').collect();
    let limit=query.get("limit").and_then(|s|s.parse::<usize>().ok()).unwrap_or(30).clamp(1,100);
    let body=if method!=Method::GET { let raw=to_bytes(request.into_body(),128*1024).await?;if raw.is_empty(){json!({})}else{serde_json::from_slice(&raw)?} } else { json!({}) };
    if path=="login"&&method==Method::POST&&!management { return login(&app,&headers,&body).await; }
    let public=!management&&method==Method::GET&&matches!(parts.first().copied(),Some("streamers"|"dynamics"|"comments"));
    let who=if public { None } else { Some(actor(&app,&headers,management).await?) };
    if let Some(who)=&who {
        if method!=Method::GET&&who.session { csrf(&app,&headers)?; }
        if who.force&&!matches!(path.as_str(),"me"|"password"|"logout") { bail!("FORBIDDEN: change initial password first"); }
    }
    if method==Method::GET {
        if path=="me" { return Ok(Json(json!({"id":who.as_ref().unwrap().id,"forcePasswordChange":who.as_ref().unwrap().force})).into_response()); }
        let after_cursor=cursor(&query)?; let params2=parts.iter().map(|s|s.to_string()).collect::<Vec<_>>(); let path2=path.clone(); let who2=who.clone(); let key=app.key;
        let value=app.db.call(move|db|{
            let p:Vec<&str>=params2.iter().map(String::as_str).collect(); let after=after_cursor;
            match p.as_slice() {
                ["streamers"]=>{
                    if let Some(w)=&who2 { w.scope("config:read")?; }
                    let last=if after.1=="~" { "" } else { &after.1 };
                    Ok(page(rows(db,"SELECT s.*,ls.status AS live_status,ls.title AS live_title,ls.checked_at,f.predicted_start_at,f.confidence,f.source AS forecast_source,f.reason AS forecast_reason,f.stale AS forecast_stale FROM streamers s LEFT JOIN live_state ls ON ls.streamer_id=s.id LEFT JOIN forecasts f ON f.id=(SELECT id FROM forecasts WHERE streamer_id=s.id AND active=1 ORDER BY created_at DESC LIMIT 1) WHERE s.id>? ORDER BY s.id LIMIT ?",&[&last,&((limit+1)as i64)],limit+1)?,limit,"created_at"))
                }
                ["streamers",sid]=>{
                    let s=one(db,"SELECT s.*,ls.status AS live_status,ls.title AS live_title,ls.checked_at FROM streamers s LEFT JOIN live_state ls ON ls.streamer_id=s.id WHERE s.id=? OR s.slug=? LIMIT 1",&[sid,sid])?;
                    if s.is_null() { bail!("NOT_FOUND: streamer"); }
                    let id=strv(&s,"id");
                    Ok(json!({"data":s,"forecast":one(db,"SELECT * FROM forecasts WHERE streamer_id=? AND active=1 ORDER BY created_at DESC LIMIT 1",&[&id])?,"rules":rows(db,"SELECT * FROM schedule_rules WHERE streamer_id=? AND active=1 ORDER BY weekday,local_time LIMIT 100",&[&id],100)?,"exceptions":rows(db,"SELECT * FROM schedule_exceptions WHERE streamer_id=? AND occurrence_date>=date('now','-14 days') ORDER BY occurrence_date DESC LIMIT 100",&[&id],100)?,"evaluations":rows(db,"SELECT * FROM prediction_evaluations WHERE streamer_id=? ORDER BY created_at DESC LIMIT 30",&[&id],30)?}))
                }
                ["streamers",sid,"dynamics"]=>{
                    let search=query.get("q").cloned().unwrap_or_default(); if search.len()>200 { bail!("search too long"); }
                    let from=query.get("from").cloned().unwrap_or_default(); let to=query.get("to").cloned().unwrap_or_else(||"9999".into()); let ty=query.get("type").cloned().unwrap_or_default(); let state=query.get("state").cloned().unwrap_or_default();
                    let has_media=query.get("hasMedia").is_some_and(|s|s=="1"||s=="true") as i64; let changed=query.get("changedOnly").is_some_and(|s|s=="1"||s=="true") as i64;
                    Ok(page(rows(db,"SELECT id,streamer_id,type,text,state,published_at,updated_at,source_url,comment_count,like_count,is_pinned,raw_excerpt FROM dynamics WHERE streamer_id=? AND (published_at,id)<(?,?) AND published_at>=? AND published_at<=? AND (?='' OR instr(text,?)>0) AND (?='' OR type=?) AND (?='' OR state=?) AND (?=0 OR EXISTS(SELECT 1 FROM dynamic_media WHERE dynamic_id=dynamics.id)) AND (?=0 OR EXISTS(SELECT 1 FROM dynamic_revisions WHERE dynamic_id=dynamics.id)) ORDER BY published_at DESC,id DESC LIMIT ?",&[sid,&after.0,&after.1,&from,&to,&search,&search,&ty,&ty,&state,&state,&has_media,&changed,&((limit+1)as i64)],limit+1)?,limit,"published_at"))
                }
                ["streamers",sid,"timeline"]=>Ok(page(rows(db,"SELECT * FROM timeline_events WHERE streamer_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",&[sid,&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,"created_at")),
                ["dynamics",did]=>{let d=one(db,"SELECT * FROM dynamics WHERE id=?",&[did])?;if d.is_null(){bail!("NOT_FOUND: dynamic");}Ok(json!({"data":d,"media":business::media(db,did)?}))}
                ["dynamics",did,"revisions"]=>Ok(page(rows(db,"SELECT id,dynamic_id,text,content_hash,created_at FROM dynamic_revisions WHERE dynamic_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",&[did,&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,"created_at")),
                ["dynamics",did,"revisions",rid]=>Ok(json!({"data":one(db,"SELECT * FROM dynamic_revisions WHERE dynamic_id=? AND id=?",&[did,rid])?})),
                ["dynamics",did,"comments"]=>Ok(page(rows(db,"SELECT * FROM comments WHERE dynamic_id=? AND root_id IS NULL AND (published_at,id)<(?,?) ORDER BY published_at DESC,id DESC LIMIT ?",&[did,&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,"published_at")),
                ["comments",cid,"replies"]=>Ok(page(rows(db,"SELECT * FROM comments WHERE root_id=? AND (published_at,id)<(?,?) ORDER BY published_at DESC,id DESC LIMIT ?",&[cid,&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,"published_at")),
                ["comments",cid,"media"]=>Ok(json!({"data":rows(db,"SELECT m.id,m.mime_type,m.state,m.sha256,COALESCE(cm.source_url,m.source_url) source_url FROM comment_media cm JOIN media_assets m ON m.id=cm.media_id WHERE cm.comment_id=? ORDER BY cm.position LIMIT 100",&[cid],100)?})),
                ["status"]=>{who2.as_ref().unwrap().scope("status:read")?;Ok(json!({"streamers":db.query_row("SELECT count(*) FROM streamers WHERE enabled=1",[],|r|r.get::<_,i64>(0))?,"dynamics":db.query_row("SELECT count(*) FROM dynamics",[],|r|r.get::<_,i64>(0))?,"jobs":db.query_row("SELECT count(*) FROM jobs WHERE status IN ('pending','running','retry')",[],|r|r.get::<_,i64>(0))?,"runtime":"rust","memoryBudgetMiB":150}))}
                ["jobs"]|["alerts"]|["audit"]|["usage"]|["drafts"]|["reviews"]=>{
                    who2.as_ref().unwrap().scope(if path2=="audit"{"audit:read"}else{"status:read"})?;
                    let(table,time_key)=match path2.as_str(){"jobs"=>("jobs","created_at"),"alerts"=>("alerts","first_seen_at"),"audit"=>("audit_log","created_at"),"usage"=>("ai_usage","created_at"),"drafts"=>("schedule_drafts","created_at"),_=>("rs_review","created_at")};
                    let sql=format!("SELECT * FROM {table} WHERE ({time_key},id)<(?,?) ORDER BY {time_key} DESC,id DESC LIMIT ?");
                    Ok(page(rows(db,&sql,&[&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,time_key))
                }
                ["secrets"]=>{who2.as_ref().unwrap().scope("secrets:read")?;Ok(json!({"data":rows(db,"SELECT key,status,last_tested_at,updated_at FROM secrets ORDER BY key LIMIT 100",&[],100)?}))}
                ["secrets",name,"reveal"]=>{
                    if !management { bail!("FORBIDDEN: reveal is management-only"); }
                    let actor=who2.as_ref().unwrap();actor.scope("secrets:read")?;
                    let secret=one(db,"SELECT encrypted_value FROM secrets WHERE key=?",&[name])?;
                    if secret.is_null(){bail!("NOT_FOUND: secret");}
                    audit(db,&actor.id,"secret.read","secret",name,json!({"value":"[REDACTED]"}))?;
                    Ok(json!({"key":name,"value":security::decrypt(&key,strv(&secret,"encrypted_value"))?}))
                }
                ["settings"]=>{who2.as_ref().unwrap().scope("config:read")?;Ok(json!({"pi_profile":setting(db,"pi_profile")?,"smtp":setting(db,"smtp")?,"bilibili_proxy_url":setting(db,"bilibili_proxy_url")?}))}
                ["tokens"]=>{who2.as_ref().unwrap().scope("secrets:read")?;Ok(json!({"data":rows(db,"SELECT id,name,token_prefix,scopes_json,expires_at,last_used_at,revoked_at,created_at FROM api_tokens ORDER BY created_at DESC LIMIT 100",&[],100)?}))}
                ["chat",conversation]=>{
                    let who=who2.as_ref().unwrap();who.scope("ops:run")?;
                    let key=format!("admin_v2:{}:{conversation}",who.id);
                    Ok(page(rows(db,"SELECT * FROM pi_messages WHERE conversation_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?",&[&key,&after.0,&after.1,&((limit+1)as i64)],limit+1)?,limit,"created_at"))
                }
                _=>bail!("NOT_FOUND: API route")
            }
        }).await?;
        return Ok(Json(value).into_response());
    }
    let who=who.context("AUTH: login required")?;
    if path=="logout" {
        if let Some(token)=cookie(&headers) { let hash=security::digest(token);app.db.call(move|db|{db.execute("DELETE FROM admin_sessions WHERE token_hash=?",[hash])?;Ok(())}).await?; }
        let mut response=Json(json!({"ok":true})).into_response();response.headers_mut().insert("set-cookie","vtbm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0".parse()?);return Ok(response);
    }
    if path=="password" {
        if !who.session { bail!("FORBIDDEN: password change requires admin session"); }
        let password=business::required(&body,"password",1024)?.to_owned();let permit=app.expensive.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: expensive work in progress"))?;
        let encoded=tokio::task::spawn_blocking(move||{let _permit=permit;security::hash_password(&password)}).await??;let actor=who.id;
        app.db.call(move|db|{let tx=db.transaction()?;tx.execute("UPDATE admins SET password_hash=?,force_password_change=0,updated_at=? WHERE id=?",params![encoded,now(),actor])?;tx.execute("DELETE FROM admin_sessions WHERE admin_id=?",[actor])?;tx.commit()?;Ok(())}).await?;
        return Ok(Json(json!({"ok":true,"loginAgain":true})).into_response());
    }
    if path=="chat" {
        who.scope("ops:run")?;let prompt=business::required(&body,"prompt",16000)?;let conversation=business::required(&body,"conversationId",64)?;
        let answer=ai::admin_chat(&app,&who.id,conversation,prompt).await?;return Ok(Json(json!({"answer":answer})).into_response());
    }
    let scope=if parts.first()==Some(&"secrets")||parts.first()==Some(&"tokens"){"secrets:write"}else if parts.contains(&"operations"){"ops:run"}else{"config:write"};who.scope(scope)?;
    let idem=headers.get("idempotency-key").and_then(|s|s.to_str().ok()).map(String::from);
    if management&&idem.is_none() { bail!("idempotency-key is required for management writes"); }
    if idem.as_ref().is_some_and(|s|s.is_empty()||s.len()>128) { bail!("invalid idempotency-key"); }
    let signature=security::digest(json!([method.as_str(),path,body]).to_string());let key=app.key;
    let result=app.db.call(move|db|atomic_write(db,|db|{
        if let Some(k)=&idem {
            let old=one(db,"SELECT request_hash,result FROM rs_idempotency WHERE key=? AND actor=?",&[k,&who.id])?;
            if !old.is_null() {
                if strv(&old,"request_hash")!=signature { bail!("CONFLICT: idempotency key reused with different request"); }
                // Receipts may contain newly issued bearer tokens: encrypt at rest too.
                if !strv(&old,"result").starts_with("v1:") { bail!("CONFLICT: legacy experiment receipt; use a new key"); }
                return Ok(serde_json::from_str(&security::decrypt(&key,strv(&old,"result"))?)?);
            }
        }
        let result=mutate(db,&who,&path,&body,&method,&key,idem.as_deref())?;
        if let Some(k)=idem {
            let receipt=security::encrypt(&key,&result.to_string())?;
            db.execute("INSERT INTO rs_idempotency VALUES(?,?,?,?,?)",params![k,who.id,signature,receipt,now()])?;
        }
        Ok(result)
    })).await?;
    Ok(Json(result).into_response())
}
// No await occurs inside this savepoint. Nested business savepoints are committed
// together with the encrypted receipt, or all are rolled back on any error.
fn atomic_write<T>(db: &mut Connection, work: impl FnOnce(&mut Connection)->Result<T>) -> Result<T> {
    db.execute_batch("SAVEPOINT rs_api_write")?;
    match work(db) {
        Ok(result)=>{db.execute_batch("RELEASE rs_api_write")?;Ok(result)}
        Err(error)=>{db.execute_batch("ROLLBACK TO rs_api_write; RELEASE rs_api_write")?;Err(error)}
    }
}
fn mutate(db: &mut Connection, who: &Actor, path: &str, body: &Value, method: &Method, key: &[u8;32], idem: Option<&str>) -> Result<Value> {
    let p:Vec<&str>=path.split('/').collect();
    if *method==Method::DELETE {
        if let ["secrets",name]=p.as_slice() {
            if *name=="bilibili_cookie" { bail!("FORBIDDEN: default cookie cannot be deleted"); }
            db.execute("DELETE FROM secrets WHERE key=?",[name])?;audit(db,&who.id,"secret.delete","secret",name,json!({"key":name}))?;return Ok(json!({"ok":true}));
        }
        bail!("NOT_FOUND: delete route");
    }
    Ok(match p.as_slice() {
        ["streamers"]=>json!({"id":business::create_streamer(db,body,&who.id)?}),
        ["streamers",sid]=>{business::update_streamer(db,sid,body,&who.id)?;json!({"ok":true})}
        ["streamers",sid,"operations",operation]=>{
            if one(db,"SELECT id FROM streamers WHERE id=?",&[sid])?.is_null(){bail!("NOT_FOUND: streamer");}
            if *operation=="reforecast" { json!({"forecastId":business::refresh_forecast(db,sid)?}) }
            else {
                let kind=match *operation{"sync"|"refresh"=>"sync_streamer","reanalyze"=>"pi_analyze",_=>bail!("unknown operation")};
                let dedupe=format!("operation:{sid}:{}",idem.map(String::from).unwrap_or_else(id));
                json!({"jobId":enqueue(db,kind,sid,json!({"fullSync":*operation=="refresh","instruction":body["instruction"]}),10,0,&dedupe)?})
            }
        }
        ["dynamics",did,"operations","refresh"]=>json!({"jobId":enqueue(db,"refresh_dynamic",did,json!({}),10,0,&format!("refresh:{did}:{}",idem.map(String::from).unwrap_or_else(id)))?}),
        ["dynamics",did,"operations","recognize"]=>{
            let dynamic=one(db,"SELECT streamer_id,content_hash,text FROM dynamics WHERE id=?",&[did])?;if dynamic.is_null(){bail!("NOT_FOUND: dynamic");}
            let draft_id=security::digest(format!("draft:{did}:{}",strv(&dynamic,"content_hash")));
            let urls:Vec<Value>=business::media(db,did)?.iter().map(|m|m["source_url"].clone()).collect();
            db.execute("INSERT OR IGNORE INTO schedule_drafts(id,streamer_id,dynamic_id,content_hash,source_text,media_urls_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",params![draft_id,strv(&dynamic,"streamer_id"),did,strv(&dynamic,"content_hash"),strv(&dynamic,"text"),json!(urls).to_string(),now(),now()])?;
            json!({"draftId":draft_id,"jobId":enqueue(db,"recognize_schedule",&draft_id,json!({}),35,0,&format!("recognize:{draft_id}:{}",id()))?})
        }
        ["streamers",sid,"rules"]=>{business::replace_rules(db,sid,body["rules"].as_array().context("rules must be array")?,&who.id)?;json!({"ok":true})}
        ["streamers",sid,"forecast"]=>{
            let fid=business::set_forecast(db,sid,business::required(body,"predictedStartAt",50)?,"manual",body["reason"].as_str().unwrap_or("人工预测"),number(body,"confidence",100),body["evidence"].clone())?;
            audit(db,&who.id,"forecast.manual","forecast",&fid,json!({"streamerId":sid}))?;json!({"id":fid})
        }
        ["drafts",did,"confirm"]=>json!({"confirmed":business::confirm_draft(db,did,body["monday"].as_str(),&who.id)?}),
        ["drafts",did,"entries"]=>{
            let entries:Vec<crate::time::Entry>=serde_json::from_value(body["entries"].clone())?;if entries.len()>70{bail!("too many entries");}
            let n=db.execute("UPDATE schedule_drafts SET entries_json=?,status='review',updated_at=? WHERE id=? AND status NOT IN ('confirmed','rejected')",params![serde_json::to_string(&entries)?,now(),did])?;
            if n==0{bail!("CONFLICT: draft not editable");}json!({"ok":true})
        }
        ["drafts",did,"reject"]=>{db.execute("UPDATE schedule_drafts SET status='rejected',reviewed_by=?,reviewed_at=?,updated_at=? WHERE id=? AND status!='confirmed'",params![who.id,now(),now(),did])?;json!({"ok":true})}
        ["drafts",did,"recognize"]=>json!({"jobId":enqueue(db,"recognize_schedule",did,json!({}),35,0,&format!("recognize:{did}:{}",id()))?}),
        ["reviews",rid,"resolve"]=>{
            let review=one(db,"SELECT * FROM rs_review WHERE id=?",&[rid])?;if review.is_null(){bail!("NOT_FOUND: review");}
            let dynamic=one(db,"SELECT content_hash FROM dynamics WHERE id=?",&[&strv(&review,"dynamic_id")])?;
            if strv(&dynamic,"content_hash")!=strv(&review,"content_hash"){bail!("CONFLICT: review source changed");}
            let fid=business::set_forecast(db,strv(&review,"streamer_id"),business::required(body,"predictedStartAt",50)?,"manual",business::required(body,"reason",2000)?,100,json!([{"type":"dynamic","id":review["dynamic_id"]}]))?;
            db.execute("UPDATE rs_review SET status='resolved' WHERE id=?",[rid])?;audit(db,&who.id,"review.resolve","review",rid,json!({"forecastId":fid}))?;json!({"id":fid})
        }
        ["alerts",aid,"acknowledge"]=>{db.execute("UPDATE alerts SET status='acknowledged',acknowledged_at=? WHERE id=?",params![now(),aid])?;json!({"ok":true})}
        ["alerts","acknowledge-all"]=>{let n=db.execute("UPDATE alerts SET status='acknowledged',acknowledged_at=? WHERE status='open'",[now()])?;json!({"count":n})}
        ["settings",name]=>{
            if !["pi_profile","smtp","bilibili_proxy_url"].contains(name){bail!("unsupported setting");}
            let value=body["value"].to_string();if value.len()>16384{bail!("setting too large");}
            db.execute("INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=settings.version+1,updated_at=excluded.updated_at",params![name,value,now()])?;
            audit(db,&who.id,"setting.write","setting",name,json!({"key":name}))?;json!({"ok":true,"restartRequired":*name=="bilibili_proxy_url"})
        }
        ["secrets",name]=>{
            if name.is_empty()||name.len()>100||!name.bytes().all(|b|b.is_ascii_alphanumeric()||b"_:.-".contains(&b)){bail!("unsupported secret name");}
            let value=security::encrypt(key,business::required(body,"value",65536)?)?;
            db.execute("INSERT INTO secrets(key,encrypted_value,status,updated_at) VALUES(?,?,'untested',?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,status='untested',updated_at=excluded.updated_at",params![name,value,now()])?;
            audit(db,&who.id,"secret.write","secret",name,json!({"value":"[REDACTED]"}))?;json!({"ok":true})
        }
        ["tokens"]=>{
            let scopes=body["scopes"].as_array().context("scopes required")?;
            if scopes.len()>10||scopes.iter().any(|s|!matches!(s.as_str(),Some("config:read"|"config:write"|"status:read"|"audit:read"|"ops:run"|"secrets:read"|"secrets:write"))){bail!("invalid scopes");}
            if let Some(expiry)=body["expiresAt"].as_str(){chrono::DateTime::parse_from_rfc3339(expiry)?;}
            let token=security::token("vtbm");let tid=id();
            db.execute("INSERT INTO api_tokens(id,name,token_prefix,token_hash,scopes_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",params![tid,business::required(body,"name",100)?,&token[..12],security::digest(&token),json!(scopes).to_string(),body["expiresAt"].as_str(),now()])?;
            json!({"id":tid,"token":token})
        }
        ["tokens",tid,"revoke"]=>{db.execute("UPDATE api_tokens SET revoked_at=? WHERE id=?",params![now(),tid])?;json!({"ok":true})}
        _=>bail!("NOT_FOUND: API route")
    })
}
async fn streamer_compat(State(app): State<Arc<App>>) -> Response {
    match app.db.call(|db|rows(db,"SELECT s.id,s.slug,s.name,s.bili_uid AS biliUid,s.room_id AS roomId,s.avatar_url AS avatarUrl,COALESCE(ls.status,'unknown') AS liveStatus,ls.title AS liveTitle,ls.checked_at AS lastCheckedAt,f.predicted_start_at AS predictedStartAt,f.confidence AS predictionConfidence,f.source AS predictionSource,f.reason AS predictionReason,f.stale AS predictionStale FROM streamers s LEFT JOIN live_state ls ON ls.streamer_id=s.id LEFT JOIN forecasts f ON f.id=(SELECT id FROM forecasts WHERE streamer_id=s.id AND active=1 ORDER BY created_at DESC LIMIT 1) WHERE s.enabled=1 ORDER BY s.name LIMIT 100",&[],100)).await { Ok(data)=>Json(json!({"streamers":data})).into_response(),Err(e)=>error_response(e) }
}
pub(crate) async fn local_media(State(app): State<Arc<App>>, Path(mid): Path<String>) -> Response {
    let result=async {
        let permit=app.media_slots.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: media capacity"))?;
        let row=app.db.call(move|db|one(db,"SELECT local_path,mime_type,sha256 FROM media_assets WHERE id=? AND state='stored'",&[&mid])).await?;
        if row.is_null(){bail!("NOT_FOUND: media");}
        let path=tokio::fs::canonicalize(app.media_dir.join(strv(&row,"local_path"))).await?;let root=tokio::fs::canonicalize(&app.media_dir).await?;
        if !path.starts_with(root){bail!("FORBIDDEN: media path");}
        let file=tokio::fs::File::open(path).await?;let size=file.metadata().await?.len();
        Ok::<Response,anyhow::Error>(Response::builder().header("content-type",strv(&row,"mime_type")).header("content-length",size).header("cache-control","public,max-age=31536000,immutable").header("x-content-type-options","nosniff").body(limits::file_body(file,permit))?)
    }.await;
    match result { Ok(r)=>r,Err(e)=>error_response(e) }
}
pub(crate) async fn image_proxy(State(app): State<Arc<App>>, Path(path): Path<String>) -> Response {
    let result=async {
        let permit=app.media_slots.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: image proxy capacity"))?;
        let raw=if path.starts_with("//"){format!("https:{path}")}else if path.starts_with("http"){path}else{format!("https://{path}")};
        let mut url=url::Url::parse(&raw)?;let host=url.host_str().unwrap_or("");
        if !(host=="hdslb.com"||host.ends_with(".hdslb.com"))||!url.username().is_empty()||url.password().is_some()||url.port().is_some(){bail!("FORBIDDEN: image host");}
        url.set_scheme("https").map_err(|_|anyhow::anyhow!("invalid image URL"))?;
        if let Some(mock)=&app.bili.mock_origin{let query=url.query().map(String::from);url=url::Url::parse(&format!("{mock}{}",url.path()))?;url.set_query(query.as_deref());}
        let response=app.client.get(url).header("referer","https://www.bilibili.com/").send().await?;
        if !response.status().is_success(){bail!("upstream image unavailable");}
        let mime=response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").to_owned();
        if !["image/png","image/jpeg","image/webp","image/gif","image/avif"].contains(&mime.as_str()){bail!("unsupported image content-type");}
        if response.content_length().is_some_and(|n|n>limits::MEDIA_LIMIT as u64){bail!("image exceeds limit");}
        Ok::<Response,anyhow::Error>(Response::builder().header("content-type",mime).header("cache-control","public,max-age=3600").header("x-content-type-options","nosniff").body(limits::upstream_stream(response,permit,limits::MEDIA_LIMIT))?)
    }.await;
    match result { Ok(r)=>r,Err(e)=>error_response(e) }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn receipt_failure_rolls_back_nested_business_write() -> Result<()> {
        let mut db=Connection::open_in_memory()?;crate::db::migrate(&mut db)?;
        let result:Result<()>=atomic_write(&mut db,|db|{
            business::create_streamer(db,&json!({"name":"test","slug":"test","biliUid":"123","roomId":"456"}),"test")?;
            bail!("simulate receipt persistence failure")
        });
        assert!(result.is_err());assert_eq!(db.query_row("SELECT count(*) FROM streamers",[],|r|r.get::<_,i64>(0))?,0);Ok(())
    }
    #[test] fn receipt_does_not_store_plaintext_token() -> Result<()> {
        let secret="vtbm_test-bearer-token";let receipt=security::encrypt(&[4;32],&json!({"token":secret}).to_string())?;
        assert!(!receipt.contains(secret));assert_eq!(serde_json::from_str::<Value>(&security::decrypt(&[4;32],&receipt)?)?["token"],secret);Ok(())
    }
}
