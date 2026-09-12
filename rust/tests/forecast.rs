use anyhow::Result;
use axum::{routing::post,Json,Router};
use base64::{engine::general_purpose::STANDARD,Engine};
use rusqlite::params;
use serde_json::{json,Value};
use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
use vtb_monitor_rs::{App,business,db,forecast,security};

#[tokio::test(flavor="current_thread")]
async fn historical_forecast_reuses_stable_evidence_and_respects_manual_lock()->Result<()> {
    let root=std::env::temp_dir().join(format!("vtbm-forecast-test-{}",db::id()));
    std::fs::create_dir_all(&root)?;
    std::env::set_var("DATA_DIR",&root);
    std::env::set_var("DATABASE_PATH",root.join("test.sqlite"));
    std::env::set_var("MEDIA_DIR",root.join("media"));
    std::env::set_var("APP_ENCRYPTION_KEY",STANDARD.encode([8u8;32]));
    std::env::set_var("ORIGIN","http://127.0.0.1:4311");
    std::env::remove_var("ADMIN_INITIAL_PASSWORD");
    std::env::remove_var("BILI_MOCK_ORIGIN");
    let calls=Arc::new(AtomicUsize::new(0));let counted=calls.clone();
    let planned=db::after(86400);
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address=listener.local_addr()?;
    let router=Router::new().route("/v1/chat/completions",post(move|Json(request):Json<Value>|{
        let calls=counted.clone();let planned=planned.clone();
        async move {
            assert_eq!(request["model"],"fixture-model");calls.fetch_add(1,Ordering::SeqCst);
            let result=json!({"predictedStartAt":planned,"confidence":55,"uncertaintyMinutes":90,
                "reason":"历史场次规律，尚未有明确公告","evidence":[{"type":"live_session","id":"history-1"}]});
            Json(json!({"choices":[{"message":{"content":result.to_string()}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}))
        }
    }));
    let server=tokio::spawn(async move{axum::serve(listener,router).await.unwrap();});
    let app=App::from_env().await?;
    let sid=app.db.call(move|connection|{
        let sid=business::create_streamer(connection,&json!({"name":"历史主播","slug":"history","biliUid":"123","roomId":"456"}),"test")?;
        connection.execute("INSERT INTO live_sessions(id,streamer_id,title,observed_start_at,observed_end_at,created_at) VALUES('history-1',?,'past',?,?,?)",params![sid,db::after(-86400),db::after(-80000),db::now()])?;
        connection.execute("INSERT INTO settings(key,value_json,updated_at) VALUES('pi_profile',?,?)",params![json!({"provider":"openai","modelId":"fixture-model","baseUrl":format!("http://{address}/v1")}).to_string(),db::now()])?;
        connection.execute("INSERT INTO secrets(key,encrypted_value,updated_at) VALUES('pi_api_key',?,?)",params![security::encrypt(&[8;32],"fixture-key")?,db::now()])?;
        Ok(sid)
    }).await?;
    forecast::predict(&app,&sid).await?;
    assert_eq!(calls.load(Ordering::SeqCst),1);
    let sid2=sid.clone();let result=app.db.call(move|c|db::one(c,"SELECT source,uncertainty_minutes FROM forecasts WHERE streamer_id=? AND active=1",&[&sid2])).await?;
    assert_eq!(result["source"],"pi");assert_eq!(result["uncertainty_minutes"],90);
    forecast::predict(&app,&sid).await?;assert_eq!(calls.load(Ordering::SeqCst),1);
    let sid2=sid.clone();app.db.call(move|c|{
        c.execute("INSERT INTO live_sessions(id,streamer_id,title,observed_start_at,observed_end_at,created_at) VALUES('history-2',?,'new past',?,?,?)",params![sid2,db::after(-43200),db::after(-40000),db::now()])?;Ok(())
    }).await?;
    forecast::predict(&app,&sid).await?;assert_eq!(calls.load(Ordering::SeqCst),2);
    let sid2=sid.clone();app.db.call(move|c|{
        business::set_forecast(c,&sid2,&db::after(7200),"manual","locked",100,json!([]))?;Ok(())
    }).await?;
    forecast::predict(&app,&sid).await?;assert_eq!(calls.load(Ordering::SeqCst),2);
    let sid2=sid.clone();assert_eq!(app.db.call(move|c|db::one(c,"SELECT source FROM forecasts WHERE streamer_id=? AND active=1",&[&sid2])).await?["source"],"manual");
    drop(app);server.abort();let _=std::fs::remove_dir_all(root);Ok(())
}
