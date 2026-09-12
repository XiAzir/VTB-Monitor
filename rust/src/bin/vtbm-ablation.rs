//! Component ablations with identical work and semantic digests. This is not an
//! old-Node/new-Rust comparison or a complete production traffic replay.
#[cfg(not(feature="bench-ablation"))]
fn main() { eprintln!("requires --features bench-ablation"); std::process::exit(2); }

#[cfg(feature="bench-ablation")]
fn main() -> anyhow::Result<()> {
    let mode=std::env::args().nth(1).unwrap_or_else(||"optimized".into());
    if !["optimized","buffer_media","eager_images","collect_rows","parallel_ai","all_disabled"].contains(&mode.as_str()) { anyhow::bail!("unknown ablation mode"); }
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(2).thread_stack_size(512*1024).build()?;
    runtime.block_on(run(mode))
}
#[cfg(feature="bench-ablation")]
async fn run(mode: String) -> anyhow::Result<()> {
    use base64::{engine::general_purpose::STANDARD,Engine};
    use futures_util::StreamExt;
    use sha2::{Digest,Sha256};
    use std::{sync::Arc,time::{Duration,Instant}};
    use vtb_monitor_rs::{App,limits};
    let app=App::from_env().await?;
    let root=std::path::PathBuf::from(std::env::var("BENCH_FIXTURE")?);
    let started=Instant::now(); let mut measurements=serde_json::Map::new(); let mut digests=serde_json::Map::new();

    // Both arms run exactly TWO concurrent transfers in each of TWO waves.
    // Only complete-body buffering versus stream consumption changes.
    let begin=Instant::now(); let buffered=mode=="buffer_media"||mode=="all_disabled";
    let mut transfer_digests=Vec::new();
    for wave in 0..2 {
        let mut tasks=Vec::new();
        for position in 0..2 {
            let app=app.clone();let path=root.join("media.bin");
            tasks.push(tokio::spawn(async move {
                let permit=app.media_slots.clone().acquire_owned().await?;
                let mut hash=Sha256::new();
                if buffered {
                    let bytes=tokio::fs::read(path).await?;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    hash.update(&bytes);std::hint::black_box(&bytes);drop(permit);
                } else {
                    let file=tokio::fs::File::open(path).await?;
                    let mut stream=limits::file_body(file,permit).into_data_stream();
                    while let Some(chunk)=stream.next().await { hash.update(chunk?);tokio::task::yield_now().await; }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Ok::<_,anyhow::Error>((wave*2+position,hex::encode(hash.finalize())))
            }));
        }
        for task in tasks { transfer_digests.push(task.await??); }
    }
    transfer_digests.sort();
    digests.insert("media".into(),serde_json::json!(transfer_digests));
    measurements.insert("mediaMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));

    // Same eight 3-MiB images. The digest covers every encoded image in order.
    // This tests allocation/serialization, NOT model recognition equivalence.
    let paths:Vec<_>=(0..8).map(|i|root.join(format!("image-{i}.bin"))).collect();
    let begin=Instant::now();let mut hash=Sha256::new();
    if mode=="eager_images"||mode=="all_disabled" {
        let data=limits::image_batch(&paths,24*1024*1024).await?;
        let encoded:Vec<_>=data.iter().map(|b|STANDARD.encode(b)).collect();
        let request=serde_json::to_vec(&encoded)?;std::hint::black_box(&request);
        tokio::time::sleep(Duration::from_millis(100)).await;
        for bytes in &encoded { hash.update(bytes.as_bytes()); }
    } else {
        for group in paths.chunks(2) {
            let data=limits::image_batch(group,6*1024*1024).await?;
            let encoded:Vec<_>=data.iter().map(|b|STANDARD.encode(b)).collect();
            let request=serde_json::to_vec(&encoded)?;std::hint::black_box(&request);
            for bytes in &encoded { hash.update(bytes.as_bytes()); }
        }
    }
    digests.insert("images".into(),serde_json::json!(hex::encode(hash.finalize())));
    measurements.insert("imagesMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));

    // Same SQL, sort order, rows and digest. Only collecting the results changes.
    let collect=mode=="collect_rows"||mode=="all_disabled";let begin=Instant::now();
    let digest=app.db.call(move|db|{
        let mut statement=db.prepare("SELECT payload FROM bench_rows ORDER BY id")?;
        let mut rows=statement.query([])?;let mut hash=Sha256::new();
        if collect {
            let mut all=Vec::new();while let Some(row)=rows.next()? { all.push(row.get::<_,String>(0)?); }
            std::thread::sleep(Duration::from_millis(100));
            for text in &all { hash.update(text.as_bytes());std::hint::black_box(text); }
        } else { while let Some(row)=rows.next()? { hash.update(row.get_ref(0)?.as_str()?.as_bytes()); } }
        Ok(hex::encode(hash.finalize()))
    }).await?;
    digests.insert("archive".into(),serde_json::json!(digest));
    measurements.insert("archiveMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));

    // Same four image->base64->JSON preparations. One versus four in flight.
    // No network/model inference, no repeated provider history or token savings claim.
    let begin=Instant::now();let parallel=mode=="parallel_ai"||mode=="all_disabled";
    let gate=Arc::new(tokio::sync::Semaphore::new(if parallel {4} else {1}));
    let mut handles=Vec::new();
    for job in 0..4 {
        let gate=gate.clone();let path=root.join("image-0.bin");
        handles.push(tokio::spawn(async move {
            let _permit=gate.acquire_owned().await?;
            let bytes=limits::image_batch(&[path],6*1024*1024).await?;
            let encoded=STANDARD.encode(&bytes[0]);
            let request=serde_json::to_vec(&serde_json::json!({"image":encoded}))?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let digest=hex::encode(Sha256::digest(&request));std::hint::black_box(&request);
            Ok::<_,anyhow::Error>((job,digest))
        }));
    }
    let mut results=Vec::new();for handle in handles { results.push(handle.await??); }results.sort();
    digests.insert("aiPreparation".into(),serde_json::json!(results));
    measurements.insert("aiPreparationMs".into(),serde_json::json!(begin.elapsed().as_secs_f64()*1000.));
    let status=std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let peak=status.lines().find(|line|line.starts_with("VmHWM:")).and_then(|line|line.split_whitespace().nth(1)).and_then(|s|s.parse::<u64>().ok());
    println!("{}",serde_json::json!({"mode":mode,"completed":true,"digests":digests,"timings":measurements,
        "elapsedMs":started.elapsed().as_secs_f64()*1000.,"peakRssKiB":peak,"pid":std::process::id(),
        "mediaConcurrencyBothArms":2,
        "note":"Component ablation with real App initialization. Identical bytes/rows are checked; this is not full feature parity, model accuracy or production traffic certification."}));
    Ok(())
}
