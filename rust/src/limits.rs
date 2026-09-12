use anyhow::{bail, Context, Result};
use axum::{body::Body, response::Response};
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use std::{io, net::SocketAddr, pin::Pin, sync::Arc, task::{Context as TaskContext, Poll}, time::Duration};
use tokio::{io::{AsyncRead, AsyncWrite, ReadBuf}, net::{TcpListener, TcpStream}, sync::{OwnedSemaphorePermit, Semaphore}};
use tokio_util::io::ReaderStream;
pub const JSON_LIMIT:usize=2*1024*1024;
pub const MEDIA_LIMIT:usize=25*1024*1024;
pub const CHUNK:usize=64*1024;
pub fn client()->Result<reqwest::Client>{Ok(reqwest::Client::builder().user_agent("VTB-Monitor-Rust/0.1").connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(40)).pool_idle_timeout(Duration::from_secs(30)).pool_max_idle_per_host(1).redirect(reqwest::redirect::Policy::none()).build()?)}
pub async fn read_bounded(mut response:reqwest::Response,max:usize)->Result<Vec<u8>>{
 if response.content_length().is_some_and(|n|n>max as u64){bail!("upstream response exceeds byte budget");}
 let mut out=Vec::with_capacity(response.content_length().unwrap_or(0).min(max as u64) as usize);
 while let Some(chunk)=response.chunk().await?{if out.len().checked_add(chunk.len()).context("size overflow")?>max{bail!("upstream response exceeds byte budget");}out.extend_from_slice(&chunk);}Ok(out)
}
pub async fn json(response:reqwest::Response)->Result<serde_json::Value>{let status=response.status();let bytes=read_bounded(response,JSON_LIMIT).await?;if !status.is_success(){bail!("upstream HTTP {}",status.as_u16());}Ok(serde_json::from_slice(&bytes)?)}
pub fn upstream_stream(response:reqwest::Response,permit:OwnedSemaphorePermit,maximum:usize)->Body{
 let deadline=tokio::time::Instant::now()+Duration::from_secs(45);
 let body=stream::try_unfold((response.bytes_stream(),permit,0usize,deadline),move |(mut upstream,permit,total,deadline)|async move{
  let next=tokio::time::timeout_at(deadline,upstream.next()).await.map_err(|_|io::Error::new(io::ErrorKind::TimedOut,"image transfer deadline"))?;
  match next{None=>Ok(None),Some(Err(e))=>Err(io::Error::other(e)),Some(Ok(chunk))=>{let count=total.checked_add(chunk.len()).ok_or_else(||io::Error::other("size overflow"))?;if count>maximum{return Err(io::Error::other("image exceeds byte budget"));}Ok(Some((chunk,(upstream,permit,count,deadline))))}}
 });Body::from_stream(body)
}
pub fn file_body(file:tokio::fs::File,permit:OwnedSemaphorePermit)->Body{
 let source=ReaderStream::with_capacity(file,CHUNK);
 Body::from_stream(stream::unfold((source,permit),|(mut source,permit)|async move{source.next().await.map(|chunk|(chunk,(source,permit)))}))
}
pub fn busy()->Response{Response::builder().status(503).header("retry-after","2").header("cache-control","no-store").body(Body::from("Busy; retry later")).unwrap()}
pub struct LimitedListener{inner:TcpListener,slots:Arc<Semaphore>}
pub struct LimitedIo{socket:TcpStream,_permit:OwnedSemaphorePermit}
impl LimitedListener{pub fn new(inner:TcpListener,count:usize)->Self{Self{inner,slots:Arc::new(Semaphore::new(count))}}}
impl axum::serve::Listener for LimitedListener{
 type Io=LimitedIo;type Addr=SocketAddr;
 async fn accept(&mut self)->(Self::Io,Self::Addr){loop{match self.inner.accept().await{Ok((socket,addr))=>{if let Ok(permit)=self.slots.clone().try_acquire_owned(){let _=socket.set_nodelay(true);return(LimitedIo{socket,_permit:permit},addr);}drop(socket);tokio::task::yield_now().await;},Err(_)=>tokio::time::sleep(Duration::from_millis(100)).await}}}
 fn local_addr(&self)->io::Result<Self::Addr>{self.inner.local_addr()}
}
impl AsyncRead for LimitedIo{fn poll_read(mut self:Pin<&mut Self>,cx:&mut TaskContext<'_>,buf:&mut ReadBuf<'_>)->Poll<io::Result<()>>{Pin::new(&mut self.socket).poll_read(cx,buf)}}
impl AsyncWrite for LimitedIo{
 fn poll_write(mut self:Pin<&mut Self>,cx:&mut TaskContext<'_>,buf:&[u8])->Poll<io::Result<usize>>{Pin::new(&mut self.socket).poll_write(cx,buf)}
 fn poll_flush(mut self:Pin<&mut Self>,cx:&mut TaskContext<'_>)->Poll<io::Result<()>>{Pin::new(&mut self.socket).poll_flush(cx)}
 fn poll_shutdown(mut self:Pin<&mut Self>,cx:&mut TaskContext<'_>)->Poll<io::Result<()>>{Pin::new(&mut self.socket).poll_shutdown(cx)}
}
pub async fn image_batch(paths:&[std::path::PathBuf],maximum:usize)->Result<Vec<Bytes>>{
 let mut output=Vec::new();let mut total=0usize;
 for path in paths{let file=tokio::fs::File::open(path).await?;let declared=file.metadata().await?.len();if declared>maximum.saturating_sub(total)as u64{bail!("image needs derivative/tile; source must remain pending for review");}let mut reader=ReaderStream::with_capacity(file,CHUNK);let mut bytes=Vec::with_capacity(declared as usize);while let Some(chunk)=reader.next().await{let chunk=chunk?;if total+bytes.len()+chunk.len()>maximum{bail!("image changed while reading or exceeds batch budget");}bytes.extend_from_slice(&chunk);}total+=bytes.len();output.push(Bytes::from(bytes));}Ok(output)
}
