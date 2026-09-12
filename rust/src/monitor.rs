use anyhow::Result;
use rusqlite::{params,Connection};
use serde_json::json;
use std::{sync::{Arc,atomic::Ordering},time::Duration};
use crate::{db::*,App};

pub fn inspect(db:&mut Connection)->Result<usize>{
    let jobs=rows(db,"SELECT id,type,entity_id,status,attempts,last_error,updated_at FROM jobs WHERE type!='send_alert_email' AND (status='failed' OR (status='retry' AND (attempts>=3 OR last_error LIKE 'DEPENDENCY: Pi API key%'))) ORDER BY updated_at DESC LIMIT 100",&[],100)?;
    let tx=db.savepoint()?;let mut created=0;
    for job in jobs {
        let job_id=strv(&job,"id");let marker=format!("alerted-job:{job_id}");
        let version=format!("{}:{}:{}",strv(&job,"status"),number(&job,"attempts",0),strv(&job,"updated_at"));
        if strv(&one(&tx,"SELECT value FROM rs_meta WHERE key=?",&[&marker])?,"value")==version{continue;}
        let fingerprint=format!("job:{}:{}",strv(&job,"type"),strv(&job,"entity_id"));
        let existing=one(&tx,"SELECT id FROM alerts WHERE fingerprint=? AND status='open' LIMIT 1",&[&fingerprint])?;
        let detail=strv(&job,"last_error").chars().take(1500).collect::<String>();
        if existing.is_null(){
            let alert=id();
            tx.execute("INSERT INTO alerts(id,fingerprint,severity,title,message,first_seen_at,last_seen_at) VALUES(?,?,'warning',?,?,?,?)",params![alert,fingerprint,format!("后台任务需要处理：{}",strv(&job,"type")),detail,now(),now()])?;
            enqueue(&tx,"send_alert_email",&alert,json!({}),20,0,&format!("alert-email:{alert}"))?;created+=1;
        }else{
            tx.execute("UPDATE alerts SET occurrences=occurrences+1,message=?,last_seen_at=? WHERE id=?",params![detail,now(),strv(&existing,"id")])?;
        }
        if strv(&job,"type")=="download_media"&&strv(&job,"status")=="failed"{
            tx.execute("UPDATE media_assets SET state='failed',error=?,updated_at=? WHERE id=? AND state='pending'",params![detail,now(),strv(&job,"entity_id")])?;
        }
        tx.execute("INSERT INTO rs_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![marker,version])?;
    }
    tx.commit()?;Ok(created)
}
pub async fn run(app:Arc<App>){
    loop{
        if app.stopping.load(Ordering::Relaxed){break;}
        if let Err(error)=app.db.call(inspect).await{eprintln!("job-alert-monitor: {}",error.to_string().chars().take(200).collect::<String>());}
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn repeated_scan_does_not_duplicate_alert_or_email()->Result<()>{
        let mut db=Connection::open_in_memory()?;crate::db::migrate(&mut db)?;
        let job=enqueue(&db,"download_media","missing",json!({}),20,0,"fixture")?;
        db.execute("UPDATE jobs SET status='failed',attempts=5,last_error='fixture download failure' WHERE id=?",[job])?;
        assert_eq!(inspect(&mut db)?,1);assert_eq!(inspect(&mut db)?,0);
        assert_eq!(db.query_row("SELECT count(*) FROM alerts",[],|r|r.get::<_,i64>(0))?,1);
        assert_eq!(db.query_row("SELECT count(*) FROM jobs WHERE type='send_alert_email'",[],|r|r.get::<_,i64>(0))?,1);Ok(())
    }
}
