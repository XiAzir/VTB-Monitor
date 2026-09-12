#![forbid(unsafe_code)]
pub mod db;
pub mod limits;
pub mod security;
pub mod time;
pub mod business;
pub mod upstream;
pub mod ai;
pub mod engine;
pub mod forecast;
pub mod monitor;
pub mod mail;
pub mod api;

use anyhow::{bail,Result};
use rusqlite::params;
use std::{path::PathBuf,sync::{Arc,atomic::AtomicBool}};
use tokio::sync::Semaphore;

pub struct App {
    pub db:db::Db,
    pub client:reqwest::Client,
    pub bili:upstream::Bili,
    pub key:[u8;32],
    pub media_dir:PathBuf,
    pub media_quota:u64,
    pub origin:String,
    pub expensive:Arc<Semaphore>,
    pub api_slots:Arc<Semaphore>,
    pub media_slots:Arc<Semaphore>,
    pub stopping:AtomicBool,
    pub dummy_password_hash:String,
}
impl App {
    pub async fn from_env()->Result<Arc<Self>> {
        let root=PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_|"data".into()));
        let media_dir=std::env::var("MEDIA_DIR").map(PathBuf::from).unwrap_or_else(|_|root.join("media"));
        tokio::fs::create_dir_all(&media_dir).await?;
        let key=security::key_from_env()?;
        let database_path=std::env::var("DATABASE_PATH").map(PathBuf::from).unwrap_or_else(|_|root.join("vtb-monitor.sqlite"));
        let db=db::Db::open(&database_path)?;
        let client=limits::client()?;
        let mock=std::env::var("BILI_MOCK_ORIGIN").ok();
        if let Some(origin)=&mock {
            if !cfg!(feature="bench-ablation") || std::env::var("VTBM_TEST_MODE").as_deref()!=Ok("1"){bail!("mock upstream requires benchmark build and VTBM_TEST_MODE=1");}
            let url=url::Url::parse(origin)?;
            let host=url.host_str().unwrap_or("");
            if url.scheme()!="http" || !["127.0.0.1","[::1]","localhost"].contains(&host){bail!("test mock must use loopback HTTP");}
        }
        let proxy=db.call(|db|db::setting(db,"bilibili_proxy_url")).await?;
        let bili_client=if let Some(proxy)=proxy.as_str().filter(|s|!s.is_empty()) {
            reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(40)).connect_timeout(std::time::Duration::from_secs(8)).pool_max_idle_per_host(1).proxy(reqwest::Proxy::all(proxy)?).build()?
        } else {client.clone()};
        let bili=upstream::Bili::new(db.clone(),bili_client,key,mock);
        let initial=std::env::var("ADMIN_INITIAL_PASSWORD").ok();
        let count=db.call(|db|Ok(db.query_row("SELECT COUNT(*) FROM admins",[],|r|r.get::<_,i64>(0))?)).await?;
        if count==0 {
            if let Some(password)=initial {
                let hash=tokio::task::spawn_blocking(move||security::hash_password(&password)).await??;
                db.call(move|db|{db.execute("INSERT INTO admins(id,username,password_hash,force_password_change,created_at,updated_at) VALUES(?,'admin',?,1,?,?)",params![db::id(),hash,db::now(),db::now()])?;Ok(())}).await?;
            }
        }
        let dummy_password_hash=tokio::task::spawn_blocking(||security::hash_password("not-a-real-user-password")).await??;
        let port=std::env::var("PORT").unwrap_or_else(|_|"4311".into());
        let origin=std::env::var("ORIGIN").unwrap_or_else(|_|format!("http://127.0.0.1:{port}"));
        let parsed=url::Url::parse(&origin)?;
        if parsed.origin().ascii_serialization()!=origin {bail!("ORIGIN must be an exact origin with no trailing slash or path");}
        let quota=std::env::var("MEDIA_QUOTA_BYTES").ok().map(|s|s.parse::<u64>()).transpose()?.unwrap_or(5*1024*1024*1024);
        Ok(Arc::new(Self{db,client,bili,key,media_dir,media_quota:quota,origin,expensive:Arc::new(Semaphore::new(1)),api_slots:Arc::new(Semaphore::new(4)),media_slots:Arc::new(Semaphore::new(2)),stopping:AtomicBool::new(false),dummy_password_hash}))
    }
}
