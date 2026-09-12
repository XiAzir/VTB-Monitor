use anyhow::{bail,Context,Result};
use std::{path::PathBuf,sync::atomic::Ordering,time::Duration,future::IntoFuture};
use vtb_monitor_rs::{api,db,engine,forecast,monitor,limits,App};

fn main()->Result<()> {
    let args:Vec<String>=std::env::args().collect();
    if args.get(1).is_some_and(|s|s=="migrate-copy") {
        if args.len()!=4{bail!("usage: vtb-monitor-rs migrate-copy SOURCE.sqlite NEW-TARGET.sqlite");}
        let source=PathBuf::from(&args[2]);let destination=PathBuf::from(&args[3]);
        if !source.is_file()||destination.exists(){bail!("source must exist and destination must not exist; original is never modified");}
        if let Some(parent)=destination.parent(){std::fs::create_dir_all(parent)?;}
        let input=rusqlite::Connection::open_with_flags(source,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut output=rusqlite::Connection::open(&destination)?;
        {let backup=rusqlite::backup::Backup::new(&input,&mut output)?;backup.run_to_completion(64,Duration::from_millis(10),None)?;}
        let check:String=output.query_row("PRAGMA quick_check",[],|row|row.get(0))?;if check!="ok"{bail!("backup integrity check failed");}
        db::migrate(&mut output)?;
        println!("{}",serde_json::json!({"copiedAndMigrated":destination,"sourceUnmodified":true}));return Ok(());
    }
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(2).thread_stack_size(512*1024).build()?;
    let local=tokio::task::LocalSet::new();
    runtime.block_on(local.run_until(async move {
        let app=App::from_env().await?;
        if args.get(1).is_some_and(|s|s=="init") {println!("initialized");return Ok(());}
        let host=std::env::var("HOST").unwrap_or_else(|_|"127.0.0.1".into());
        let address:std::net::IpAddr=host.parse().context("HOST must be a numeric loopback address")?;
        if !address.is_loopback(){bail!("bind to loopback and use an authenticated TLS reverse proxy");}
        let port=std::env::var("PORT").unwrap_or_else(|_|"4311".into()).parse::<u16>()?;
        let management_port=std::env::var("MANAGEMENT_PORT").unwrap_or_else(|_|"4312".into()).parse::<u16>()?;
        let listener=tokio::net::TcpListener::bind((address,port)).await?;
        let admin_listener=tokio::net::TcpListener::bind((address,management_port)).await?;
        let enabled=std::env::var("DISABLE_SCHEDULER").as_deref()!=Ok("1");
        let worker=if enabled {Some(tokio::task::spawn_local(engine::run(app.clone())))}else{None};
        let live=if enabled {Some(tokio::task::spawn_local(engine::live_loop(app.clone())))}else{None};
        let predictions=if enabled {Some(tokio::task::spawn_local(forecast::run(app.clone())))}else{None};
        let notifications=if enabled {Some(tokio::task::spawn_local(monitor::run(app.clone())))}else{None};
        let web=tokio::spawn(axum::serve(limits::LimitedListener::new(listener,16),api::router(app.clone())).into_future());
        let management=tokio::spawn(axum::serve(limits::LimitedListener::new(admin_listener,4),api::management_router(app.clone())).into_future());
        println!("{}",serde_json::json!({"event":"ready","pid":std::process::id(),"port":port,"managementPort":management_port,"runtime":"rust","scheduler":enabled}));
        #[cfg(unix)]{let mut term=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;tokio::select!{_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}}
        #[cfg(not(unix))]tokio::signal::ctrl_c().await?;
        app.stopping.store(true,Ordering::Relaxed);web.abort();management.abort();
        if let Some(live)=live{live.abort();}if let Some(predictions)=predictions{predictions.abort();}
        if let Some(notifications)=notifications{notifications.abort();}
        if let Some(worker)=worker{let _=tokio::time::timeout(Duration::from_secs(130),worker).await;}
        Ok::<(),anyhow::Error>(())
    }))?;
    runtime.shutdown_timeout(Duration::from_secs(2));Ok(())
}
