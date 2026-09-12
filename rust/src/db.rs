use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde_json::{json, Map, Value};
use std::{path::Path, sync::mpsc};
use tokio::sync::oneshot;

pub fn now() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
pub fn after(seconds: i64) -> String { (chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }
pub fn id() -> String { uuid::Uuid::new_v4().to_string() }
pub fn strv<'a>(v: &'a Value, key: &str) -> &'a str { v.get(key).and_then(Value::as_str).unwrap_or("") }
pub fn number(v: &Value, key: &str, fallback: i64) -> i64 { v.get(key).and_then(Value::as_i64).unwrap_or(fallback) }

type Work = Box<dyn FnOnce(&mut Connection) + Send>;
#[derive(Clone)]
pub struct Db { sender: mpsc::SyncSender<Work> }
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) { std::fs::create_dir_all(parent)?; }
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_millis(500))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;")?;
        connection.set_prepared_statement_cache_capacity(16);
        migrate(&mut connection)?;
        let (sender, receiver) = mpsc::sync_channel::<Work>(16);
        std::thread::Builder::new().name("sqlite".into()).stack_size(512 * 1024).spawn(move || {
            for job in receiver { job(&mut connection); }
            let _ = connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
        })?;
        Ok(Self { sender })
    }
    pub async fn call<T, F>(&self, f: F) -> Result<T>
    where T: Send + 'static, F: FnOnce(&mut Connection) -> Result<T> + Send + 'static {
        let (tx, rx) = oneshot::channel();
        self.sender.try_send(Box::new(move |db| { let _ = tx.send(f(db)); }))
            .map_err(|_| anyhow!("BUSY: database queue full or stopped"))?;
        rx.await.context("database actor stopped")?
    }
}

pub fn migrate(db: &mut Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);")?;
    // Original migration SQL is embedded at build time; no Node/TypeScript runtime is used.
    let source = include_str!("../../src/lib/server/migrations.ts");
    for part in source.split("version:").skip(1) {
        let version: i64 = part.split(',').next().context("migration version")?.trim().parse()?;
        let sql = part.split('`').nth(1).context("migration SQL")?;
        if sql.contains("${") { bail!("unsupported interpolated legacy migration"); }
        if db.query_row("SELECT 1 FROM schema_migrations WHERE version=?", [version], |_| Ok(1)).optional()?.is_none() {
            let tx = db.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute("INSERT INTO schema_migrations VALUES(?,?)", params![version, now()])?;
            tx.commit()?;
        }
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS rs_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rs_scan_items(scan_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(scan_id,item_id));
      CREATE TABLE IF NOT EXISTS rs_observations(id TEXT PRIMARY KEY,streamer_id TEXT NOT NULL,lower_at TEXT,upper_at TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rs_content_cache(cache_key TEXT PRIMARY KEY,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rs_job_receipts(job_id TEXT NOT NULL,receipt_key TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,receipt_key));
      CREATE TABLE IF NOT EXISTS rs_media_refs(owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,media_id TEXT NOT NULL,PRIMARY KEY(owner_type,owner_id,media_id));
      CREATE TABLE IF NOT EXISTS rs_review(id TEXT PRIMARY KEY,streamer_id TEXT,dynamic_id TEXT,content_hash TEXT,kind TEXT NOT NULL,result_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'review',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rs_idempotency(key TEXT NOT NULL,actor TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(key,actor));
      INSERT OR IGNORE INTO rs_meta VALUES('schema','1');")?;
    Ok(())
}

pub fn rows(db: &Connection, sql: &str, args: &[&dyn ToSql], max_rows: usize) -> Result<Vec<Value>> {
    let mut statement = db.prepare_cached(sql)?;
    let names: Vec<String> = statement.column_names().iter().map(|s| s.to_string()).collect();
    let mut cursor = statement.query(args)?;
    let mut result = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = cursor.next()? {
        if result.len() >= max_rows { bail!("result exceeds row budget; use cursor pagination"); }
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => {
                    bytes = bytes.checked_add(s.len()).context("result overflow")?;
                    if bytes > 2 * 1024 * 1024 { bail!("result exceeds byte budget; use smaller page"); }
                    Value::String(std::str::from_utf8(s)?.to_owned())
                },
                ValueRef::Blob(_) => bail!("binary SQL columns are not exposed"),
            };
            object.insert(name.clone(), value);
        }
        result.push(Value::Object(object));
    }
    Ok(result)
}
pub fn one(db: &Connection, sql: &str, args: &[&dyn ToSql]) -> Result<Value> {
    Ok(rows(db, sql, args, 1)?.into_iter().next().unwrap_or(Value::Null))
}
pub fn setting(db: &Connection, key: &str) -> Result<Value> {
    let value: Option<String> = db.query_row("SELECT value_json FROM settings WHERE key=?", [key], |r| r.get(0)).optional()?;
    Ok(value.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}
pub fn audit(db: &Connection, actor: &str, action: &str, entity: &str, record: &str, details: Value) -> Result<()> {
    db.execute("INSERT INTO audit_log(id,actor_type,action,entity_type,entity_id,after_json,created_at) VALUES(?,?,?,?,?,?,?)",
        params![id(), actor, action, entity, record, details.to_string(), now()])?;
    Ok(())
}
pub fn enqueue(db: &Connection, kind: &str, entity: &str, payload: Value, priority: i64, delay: i64, dedupe: &str) -> Result<String> {
    let new_id = id();
    db.execute("INSERT INTO jobs(id,type,entity_id,payload_json,priority,due_at,dedupe_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING",
        params![new_id, kind, entity, payload.to_string(), priority, after(delay), dedupe, now(), now()])?;
    Ok(db.query_row("SELECT id FROM jobs WHERE dedupe_key=?", [dedupe], |r| r.get(0))?)
}
pub fn claim(db: &mut Connection, owner: &str) -> Result<Value> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let job = one(&tx, "SELECT * FROM jobs WHERE status IN ('pending','retry','running') AND due_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY priority,due_at LIMIT 1", &[&now(), &now()])?;
    if !job.is_null() {
        tx.execute("UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?", params![owner,after(180),now(),strv(&job,"id")])?;
    }
    tx.commit()?;
    Ok(job)
}
pub fn finish(db: &Connection, job: &str, owner: &str, error: Option<&str>, delay: i64) -> Result<()> {
    let status = if error.is_none() { "done" } else { "retry" };
    // Every completion is fenced. A stale worker cannot acknowledge a newer lease.
    db.execute("UPDATE jobs SET status=CASE WHEN ?='retry' AND attempts>=max_attempts THEN 'failed' ELSE ? END,lease_owner=NULL,lease_until=NULL,last_error=?,due_at=?,updated_at=? WHERE id=? AND lease_owner=?", params![status,status,error,after(delay),now(),job,owner])?;
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn legacy_schema_and_jobs_are_idempotent() -> Result<()> {
        let mut db=Connection::open_in_memory()?; migrate(&mut db)?; migrate(&mut db)?;
        let first=enqueue(&db,"test","",json!({}),1,0,"x")?;
        assert_eq!(first,enqueue(&db,"test","",json!({}),1,0,"x")?);
        let job=claim(&mut db,"owner-a")?; assert_eq!(strv(&job,"id"),first);
        assert!(claim(&mut db,"owner-b")?.is_null());
        finish(&db,&first,"owner-b",None,0)?;
        assert_eq!(strv(&one(&db,"SELECT status FROM jobs WHERE id=?",&[&first])?,"status"),"running");
        finish(&db,&first,"owner-a",None,0)?;
        assert_eq!(strv(&one(&db,"SELECT status FROM jobs WHERE id=?",&[&first])?,"status"),"done"); Ok(())
    }
    #[test] fn row_budget_is_not_silent_truncation() -> Result<()> {
        let db=Connection::open_in_memory()?;
        assert!(rows(&db,"SELECT 1 UNION ALL SELECT 2", &[],1).is_err()); Ok(())
    }
}
