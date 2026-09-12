//! Component ablation harness. It initializes the real application and uses its
//! streaming/image/DB primitives, but does not claim a production workload replay.
#[cfg(not(feature="bench-ablation"))]
fn main(){eprintln!("This binary requires --features bench-ablation");std::process::exit(2);}

#[cfg(feature="bench-ablation")]
fn main()->anyhow::Result<()> {
    let args:Vec<String>=std::env::args().collect();
    let mode=args.get(1).cloned().unwrap_or_else(||"optimized".into());
    if !["optimized","buffer_media","eager_images","collect_rows","parallel_ai","all_disabled"].contains(&mode.as_str()){anyhow::bail!("unknown ablation mode");}
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(2).thread_stack_size(512*1024).build()?;
    runtime.block_on(run(mode))
}
#[cfg(feature="bench-ablation")]
async fn run(mode:String)->anyhow::Result<()> {
    use anyhow::Result;
    use base64::{engine::general_purpose::STANDARD,Engine};
    use futures_util::StreamExt;
    use sha2::{Digest,Sha256};
    use std::{sync::Arc,time::{Duration,Instant}};
    use vtb_monitor_rs::{App,limits};
    let app=App::from_env().await?;
    let root=std::path::PathBuf::from(std::env::var("BENCH_FIXTURE")?);
    let started=Instant::now();let mut measurements=serde_json::Map::new();let mut digests=serde_json::Map::new();
    // Four equal 24 MiB transfers. The disabled arm retains all four responses,
    // reproducing concurrency + complete-body buffering rather than shrinking input.
    let begin=Instant::now();let mut hash=Sha256::new();
    if mode=="buffer_media"||mode=="all_disabled"{
        let mut all=Vec::new();for _ in 0..4{all.push(tokio::fs::read(root.join("media.bin")).await?);}
        tokio::time::sleep(Duration::from_millis(100)).await;
        for bytes in &all{hash.update(bytes);std::hint::black_box(bytes);}
    }else{
        for _ in 0..4{let file=tokio::fs::File::open(root.join("media.bin")).await?;let permit=app.media_slots.clone().acquire_owned().await?;let mut stream=limits::file_body(file,permit).into_data_stream();while let Some(chunk)=stream.next().await{hash.update(chunk?);}}
    }
    digests.insert("media".into(),serde_json::json!(hex::encode(hash.finalize())));measurements.insert("mediaMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));
    // Same eight 3 MiB images, same base64 payload representation and digest.
    let paths:Vec<_>=(0..8).map(|i|root.join(format!("image-{i}.bin"))).collect();
    let begin=Instant::now();let mut hash=Sha256::new();
    if mode=="eager_images"||mode=="all_disabled"{
        let data=limits::image_batch(&paths,24*1024*1024).await?;
        let encoded:Vec<_>=data.iter().map(|b|STANDARD.encode(b)).collect();
        let request=serde_json::to_vec(&encoded)?;std::hint::black_box(&request);
        tokio::time::sleep(Duration::from_millis(100)).await;
        for b in &encoded{hash.update(b.as_bytes());}
    }else{
        for group in paths.chunks(2){let data=limits::image_batch(group,6*1024*1024).await?;let encoded:Vec<_>=data.iter().map(|b|STANDARD.encode(b)).collect();let request=serde_json::to_vec(&encoded)?;std::hint::black_box(&request);for b in &encoded{hash.update(b.as_bytes());}}
    }
    digests.insert("images".into(),serde_json::json!(hex::encode(hash.finalize())));measurements.insert("imagesMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));
    // 6,000 16-KiB archive records. Cursor arm never accumulates historic payloads.
    let collect=mode=="collect_rows"||mode=="all_disabled";let begin=Instant::now();
    let digest=app.db.call(move|db|{
        let mut statement=db.prepare("SELECT payload FROM bench_rows ORDER BY id")?;let mut rows=statement.query([])?;let mut hash=Sha256::new();
        if collect{let mut all=Vec::new();while let Some(row)=rows.next()?{all.push(row.get::<_,String>(0)?);}std::thread::sleep(Duration::from_millis(100));for s in &all{hash.update(s.as_bytes());std::hint::black_box(s);}}
        else{while let Some(row)=rows.next()?{let s=row.get_ref(0)?.as_str()?;hash.update(s.as_bytes());}}
        Ok(hex::encode(hash.finalize()))
    }).await?;
    digests.insert("archive".into(),serde_json::json!(digest));measurements.insert("archiveMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));
    // Four identical simulated provider preparations. No network/model inference:
    // only the image->base64->JSON stages that contribute local process memory.
    let begin=Instant::now();let parallel=mode=="parallel_ai"||mode=="all_disabled";
    let count=if parallel{4}else{1};let sem=Arc::new(tokio::sync::Semaphore::new(count));let mut handles=Vec::new();
    for job in 0..4{let gate=sem.clone();let path=root.join("image-0.bin");handles.push(tokio::spawn(async move{
        let _permit=gate.acquire_owned().await?;let bytes=limits::image_batch(&[path],6*1024*1024).await?;
        let encoded=STANDARD.encode(&bytes[0]);let request=serde_json::to_vec(&serde_json::json!({"image":encoded}))?;
        tokio::time::sleep(Duration::from_millis(100)).await;let digest=hex::encode(Sha256::digest(&request));std::hint::black_box(&request);Ok::<_,anyhow::Error>((job,digest))
    }));}
    let mut results=Vec::new();for handle in handles{results.push(handle.await??);}results.sort();
    digests.insert("aiPreparation".into(),serde_json::json!(results));measurements.insert("aiPreparationMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));
    let status=std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let peak=status.lines().find(|l|l.starts_with("VmHWM:")).and_then(|l|l.split_whitespace().nth(1)).and_then(|s|s.parse::<u64>().ok());
    println!("{}",serde_json::json!({"mode":mode,"completed":true,"digests":digests,"timings":measurements,"elapsedMs":started.elapsed().as_secs_f64()*1000.,"peakRssKiB":peak,"pid":std::process::id(),"note":"Component ablation with real application initialization; no real external service calls; not complete feature parity certification"}));
    Ok::<(),anyhow::Error>(())
}
