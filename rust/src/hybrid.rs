//! Private original-Svelte/TypeScript-Pi helper with bounded admission and idle reaping.
use anyhow::{bail, Context, Result};
use axum::{body::{to_bytes, Body}, extract::State, http::{HeaderMap, Method, Request}, response::Response, routing::{any, get}, Json, Router};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{io, path::{Path, PathBuf}, process::Stdio, sync::{Arc, atomic::{AtomicUsize, AtomicU64, Ordering}}, time::{Duration, Instant}};
use tokio::{io::AsyncReadExt, process::{Child, ChildStdin, Command}, sync::{Mutex, OwnedSemaphorePermit}};
use crate::{db::{number, strv}, limits, App};
struct Running { child: Child, _stdin: ChildStdin, port: u16 }
struct Activity { count: AtomicUsize, last: AtomicU64, origin: Instant }
impl Activity { fn clock(&self) -> u64 { self.origin.elapsed().as_millis() as u64 } }
pub struct Lease { pub port: u16, activity: Arc<Activity> }
impl Drop for Lease {
    fn drop(&mut self) {
        self.activity.last.store(self.activity.clock(), Ordering::Release);
        self.activity.count.fetch_sub(1, Ordering::AcqRel);
    }
}
fn absolute(cwd: &Path, path: PathBuf) -> PathBuf { if path.is_absolute() { path } else { cwd.join(path) } }
pub struct Bridge {
    state: Mutex<Option<Running>>, activity: Arc<Activity>, token: String,
    root: PathBuf, data_dir: PathBuf, database: PathBuf, media: PathBuf,
    node: String, idle: Duration, pub client: reqwest::Client,
}
impl Bridge {
    pub fn new() -> Result<Arc<Self>> {
        let cwd = std::env::current_dir()?;
        let root = absolute(&cwd, std::env::var("VTBM_APP_ROOT").map(PathBuf::from).unwrap_or_else(|_|cwd.clone()));
        let data_dir = absolute(&cwd, std::env::var("DATA_DIR").map(PathBuf::from).unwrap_or_else(|_|PathBuf::from("data")));
        let database = absolute(&cwd, std::env::var("DATABASE_PATH").map(PathBuf::from).unwrap_or_else(|_|data_dir.join("vtb-monitor.sqlite")));
        let media = absolute(&cwd, std::env::var("MEDIA_DIR").map(PathBuf::from).unwrap_or_else(|_|data_dir.join("media")));
        let idle_ms: u64 = std::env::var("VTBM_SIDECAR_IDLE_MS").unwrap_or_else(|_| "30000".into()).parse()?;
        if !(1000..=3600000).contains(&idle_ms) { bail!("invalid sidecar idle timeout"); }
        let this = Arc::new(Self {
            state: Mutex::new(None), activity: Arc::new(Activity { count: AtomicUsize::new(0), last: AtomicU64::new(0), origin: Instant::now() }),
            token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
            root, data_dir, database, media,
            node: std::env::var("VTBM_NODE").unwrap_or_else(|_| "node".into()), idle: Duration::from_millis(idle_ms),
            client: reqwest::Client::builder().no_proxy().no_gzip().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(300))
                .pool_max_idle_per_host(2).pool_idle_timeout(Duration::from_secs(2)).build()?,
        });
        let weak = Arc::downgrade(&this);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let Some(bridge) = weak.upgrade() else { return; };
                let mut state = bridge.state.lock().await;
                if bridge.activity.count.load(Ordering::Acquire) == 0
                    && bridge.activity.clock().saturating_sub(bridge.activity.last.load(Ordering::Acquire)) >= bridge.idle.as_millis() as u64 {
                    if let Some(mut running) = state.take() {
                        let pid = running.child.id(); let _ = running.child.kill().await;
                        eprintln!("{}", json!({"event":"sidecar-idle-stop","pid":pid}));
                    }
                }
            }
        });
        Ok(this)
    }
    pub async fn acquire(self: &Arc<Self>) -> Result<Lease> {
        let mut state = self.state.lock().await;
        if let Some(child) = state.as_mut() { if child.child.try_wait()?.is_some() { *state = None; } }
        if state.is_none() {
            if !self.root.join("build/handler.js").is_file() { bail!("original WebUI build missing; run npm run build"); }
            let old_space: u32 = std::env::var("VTBM_NODE_OLD_MB").unwrap_or_else(|_| "48".into()).parse()?;
            if !(48..=128).contains(&old_space) { bail!("VTBM_NODE_OLD_MB must be in 48..128"); }
            let mut child = Command::new(&self.node)
                .arg(format!("--max-old-space-size={old_space}")).arg("--max-semi-space-size=1")
                .arg("--expose-gc").arg("--optimize-for-size")
                .arg(self.root.join("hybrid/sidecar.mjs")).current_dir(&self.root)
                .env("DATA_DIR", &self.data_dir).env("DATABASE_PATH", &self.database).env("MEDIA_DIR", &self.media)
                .env_remove("NODE_OPTIONS").env("VTBM_HYBRID_CHILD", "1")
                .env("VTBM_SIDECAR_TOKEN", &self.token).env("DISABLE_SCHEDULER", "1").env("RUN_SCHEDULER", "0")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).kill_on_drop(true).spawn()?;
            let mut output = child.stdout.take().context("sidecar stdout missing")?;
            let line = tokio::time::timeout(Duration::from_secs(15), async {
                let mut line = Vec::new();
                loop { let byte = output.read_u8().await?; if byte == b'\n' { return Ok::<_,io::Error>(line); }
                    if line.len() >= 512 { return Err(io::Error::other("sidecar handshake too long")); } line.push(byte); }
            }).await.context("sidecar start deadline")??;
            let ready: Value = serde_json::from_slice(&line)?;
            let port = ready["port"].as_u64().filter(|p| *p > 0 && *p <= 65535).context("invalid sidecar port")? as u16;
            let stdin = child.stdin.take().context("sidecar stdin missing")?;
            eprintln!("{}", json!({"event":"sidecar-start","pid":child.id()}));
            tokio::spawn(async move { let _ = tokio::io::copy(&mut output, &mut tokio::io::sink()).await; });
            *state = Some(Running { child, _stdin: stdin, port });
        }
        let port = state.as_ref().unwrap().port;
        self.activity.count.fetch_add(1, Ordering::AcqRel);
        Ok(Lease { port, activity: self.activity.clone() })
    }
    pub async fn shutdown(&self) {
        if let Some(mut running) = self.state.lock().await.take() { let _ = running.child.kill().await; }
    }
    pub async fn run_job(self: &Arc<Self>, app: &Arc<App>, job: &Value) -> Result<()> {
        let _permit = app.expensive.clone().try_acquire_owned().map_err(|_| anyhow::anyhow!("BUSY: Pi/authentication capacity"))?;
        let lease = self.acquire().await?;
        let payload: Value = serde_json::from_str(strv(job,"payload_json"))?;
        let input = json!({"type":strv(job,"type"),"entityId":strv(job,"entity_id"),"payload":payload,"attemptNumber":number(job,"attempts",1)});
        let bytes = serde_json::to_vec(&input)?;
        if bytes.len() > 65536 { bail!("Pi job exceeds control budget"); }
        let response = self.client.post(format!("http://127.0.0.1:{}/control/pi",lease.port))
            .header("x-vtbm-sidecar-token",&self.token).header("content-type","application/json").body(bytes).send().await?;
        let status = response.status(); let bytes = limits::read_bounded(response, 65536).await?;
        let result: Value = serde_json::from_slice(&bytes)?;
        if !status.is_success() || result["ok"] != true { bail!("{}",result["error"].as_str().unwrap_or("TypeScript Pi job failed")); }
        Ok(())
    }
}
fn target(port: u16, namespace: &str, path: &str) -> Result<url::Url> {
    if path.split('?').next().unwrap_or("").contains('\\') { bail!("backslash in request path"); }
    let url = url::Url::parse(&format!("http://127.0.0.1:{port}/{namespace}{path}"))?;
    if url.host_str() != Some("127.0.0.1") || url.port_or_known_default() != Some(port)
        || !url.path().starts_with(&format!("/{namespace}/")) { bail!("invalid request namespace"); }
    Ok(url)
}
fn clean_headers(headers: &mut HeaderMap) {
    let named: Vec<String> = headers.get_all("connection").iter()
        .filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(','))
        .map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    for name in named { headers.remove(name.as_str()); }
    for name in ["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade",
        "x-vtbm-sidecar-token","x-vtbm-management-listener"] { headers.remove(name); }
}
pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/healthz",get(||async{Json(json!({"status":"ok","runtime":"rust+typescript-pi","ui":"original-svelte"}))}))
        .route("/media/{id}",get(crate::api::local_media)).route("/api/image-proxy/{*path}",get(crate::api::image_proxy))
        .fallback(any(web)).with_state(app)
}
pub fn management_router(app: Arc<App>) -> Router { Router::new().fallback(any(management)).with_state(app) }
async fn web(State(app): State<Arc<App>>, request: Request<Body>) -> Response { forward(app,request,false).await }
async fn management(State(app): State<Arc<App>>, request: Request<Body>) -> Response { forward(app,request,true).await }
async fn forward(app: Arc<App>, request: Request<Body>, management: bool) -> Response {
    match forward_inner(app,request,management).await { Ok(r)=>r, Err(e)=>{eprintln!("hybrid request failed: {}",e.to_string().chars().take(200).collect::<String>());limits::busy()} }
}
async fn forward_inner(app: Arc<App>, request: Request<Body>, management: bool) -> Result<Response> {
    let bridge = app.bridge.as_ref().context("hybrid adapter disabled")?;
    let api_permit = tokio::time::timeout(Duration::from_secs(15), app.api_slots.clone().acquire_owned()).await
        .context("BUSY: request admission deadline")?.context("request admission closed")?;
    let (parts,body) = request.into_parts(); let namespace = if management { "management" } else { "web" };
    let path = parts.uri.path_and_query().map(|p|p.as_str()).unwrap_or("/");
    if !path.starts_with('/') { bail!("invalid request target"); }
    let expensive: Option<OwnedSemaphorePermit> = if parts.method != Method::GET && parts.method != Method::HEAD {
        Some(app.expensive.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: Pi/authentication capacity"))?)
    } else { None };
    let lease = bridge.acquire().await?;
    let bytes = read_request_body(body, Duration::from_secs(15)).await?;
    let mut headers = parts.headers; clean_headers(&mut headers); headers.remove("content-length");
    let upstream = bridge.client.request(parts.method,target(lease.port,namespace,path)?)
        .headers(headers).header("x-vtbm-sidecar-token",&bridge.token).body(bytes).send().await?;
    let mut response = Response::builder().status(upstream.status());
    let mut headers = upstream.headers().clone(); clean_headers(&mut headers);
    *response.headers_mut().context("response headers")? = headers;
    let stream = stream::unfold((upstream.bytes_stream(),lease,api_permit,expensive),|(mut source,lease,permit,expensive)|async move{
        source.next().await.map(|chunk|(chunk.map_err(io::Error::other),(source,lease,permit,expensive)))
    });
    Ok(response.body(Body::from_stream(stream))?)
}
async fn read_request_body(body: Body, deadline: Duration) -> Result<bytes::Bytes> {
    tokio::time::timeout(deadline, to_bytes(body, 512 * 1024)).await
        .context("request body read deadline")?
        .context("request body exceeds 512 KiB or was interrupted")
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn strips_hop_headers_and_private_capabilities() {
        let mut h=HeaderMap::new();h.insert("connection","x-private, keep-alive".parse().unwrap());h.insert("x-private","bad".parse().unwrap());
        h.insert("x-vtbm-sidecar-token","bad".parse().unwrap());h.insert("cookie","vtbm_session=test".parse().unwrap());
        clean_headers(&mut h);assert!(!h.contains_key("x-private"));assert!(!h.contains_key("x-vtbm-sidecar-token"));assert!(h.contains_key("cookie"));
    }
    #[test] fn strips_every_connection_field_but_preserves_response_cookies() {
        let mut h = HeaderMap::new();
        h.append("connection", "x-first".parse().unwrap());
        h.append("connection", "x-second, keep-alive".parse().unwrap());
        h.insert("x-first", "one".parse().unwrap());
        h.insert("x-second", "two".parse().unwrap());
        h.append("set-cookie", "first=1; HttpOnly".parse().unwrap());
        h.append("set-cookie", "second=2; HttpOnly".parse().unwrap());
        h.insert("location", "/admin".parse().unwrap());
        clean_headers(&mut h);
        assert!(!h.contains_key("x-first")); assert!(!h.contains_key("x-second"));
        assert_eq!(h.get_all("set-cookie").iter().count(), 2);
        assert_eq!(h.get("location").unwrap(), "/admin");
    }
    #[tokio::test] async fn request_body_is_bounded_and_not_rewritten() {
        let input = bytes::Bytes::from_static(b"name=original%20form");
        assert_eq!(read_request_body(Body::from(input.clone()), Duration::from_secs(1)).await.unwrap(), input);
        assert!(read_request_body(Body::from(vec![0u8; 512 * 1024 + 1]), Duration::from_secs(1)).await.is_err());
    }
    #[tokio::test] async fn stalled_body_cannot_hold_admission_forever() {
        let body = Body::from_stream(stream::pending::<Result<bytes::Bytes, io::Error>>());
        let error = read_request_body(body, Duration::from_millis(10)).await.unwrap_err();
        assert!(error.to_string().contains("deadline"));
    }
    #[test] fn cannot_escape_public_namespace() {
        for path in ["/../control/pi", "/%2e%2e/control/pi", "/%2E./management/v1/healthz", "/\\..\\control/pi"] { assert!(target(1234,"web",path).is_err(),"{path}"); }
        assert_eq!(target(1234,"web","/admin?/login").unwrap().path(),"/web/admin");
    }
    #[test] fn lease_counts_until_drop() {
        let a=Arc::new(Activity{count:AtomicUsize::new(1),last:AtomicU64::new(0),origin:Instant::now()});
        let lease=Lease{port:1,activity:a.clone()};assert_eq!(a.count.load(Ordering::Acquire),1);drop(lease);assert_eq!(a.count.load(Ordering::Acquire),0);
    }
    #[test] fn relative_paths_use_parent_directory() {
        assert_eq!(absolute(Path::new("/srv/run"),PathBuf::from("data")),PathBuf::from("/srv/run/data"));
        assert_eq!(absolute(Path::new("/srv/run"),PathBuf::from("/var/lib/vtbm")),PathBuf::from("/var/lib/vtbm"));
    }
}
