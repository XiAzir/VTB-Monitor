use anyhow::{bail,Result};
use lettre::{message::header::ContentType,transport::smtp::authentication::Credentials,Message,SmtpTransport,Transport};
use serde_json::Value;
use std::sync::Arc;
use crate::{db::{self,*},security,App};

pub async fn send(app:&Arc<App>,alert_id:&str)->Result<()> {
    let alert_id=alert_id.to_owned();let key=app.key;
    let data=app.db.call(move|db|{
        let alert=one(db,"SELECT title,message,severity,status FROM alerts WHERE id=?",&[&alert_id])?;
        let smtp=setting(db,"smtp")?;
        let secret=one(db,"SELECT encrypted_value FROM secrets WHERE key='smtp_password'",&[])?;
        let password=if secret.is_null(){String::new()}else{security::decrypt(&key,strv(&secret,"encrypted_value"))?};
        Ok((alert,smtp,password))
    }).await?;
    let (alert,smtp,password)=data;
    if alert.is_null() || strv(&alert,"status")=="resolved" {return Ok(());}
    if smtp.is_null(){bail!("DEPENDENCY: SMTP not configured");}
    let permit=app.expensive.clone().try_acquire_owned().map_err(|_|anyhow::anyhow!("BUSY: expensive work already running"))?;
    tokio::task::spawn_blocking(move|| -> Result<()> {
        let _permit=permit;
        let host=strv(&smtp,"host");if host.is_empty(){bail!("SMTP host missing");}
        let port=number(&smtp,"port",587);if !(1..=65535).contains(&port){bail!("invalid SMTP port");}
        let message=Message::builder().from(strv(&smtp,"from").parse()?).to(strv(&smtp,"to").parse()?)
            .subject(format!("[VTB Monitor / {}] {}",strv(&alert,"severity"),strv(&alert,"title")))
            .header(ContentType::TEXT_PLAIN).body(strv(&alert,"message").chars().take(8000).collect::<String>())?;
        let mut transport=if smtp["secure"].as_bool().unwrap_or(port==465){SmtpTransport::relay(host)?}else{SmtpTransport::starttls_relay(host)?};
        transport=transport.port(port as u16).timeout(Some(std::time::Duration::from_secs(20)));
        if !strv(&smtp,"username").is_empty(){transport=transport.credentials(Credentials::new(strv(&smtp,"username").to_owned(),password));}
        transport.build().send(&message)?;Ok(())
    }).await??;
    Ok(())
}
