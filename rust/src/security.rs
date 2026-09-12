use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn digest(bytes: impl AsRef<[u8]>) -> String { hex::encode(Sha256::digest(bytes.as_ref())) }
pub fn token(prefix: &str) -> String {
    let mut value=[0u8;32]; OsRng.fill_bytes(&mut value);
    format!("{prefix}_{}",URL_SAFE_NO_PAD.encode(value))
}
pub fn key_from_env() -> Result<[u8;32]> {
    let bytes=STANDARD.decode(std::env::var("APP_ENCRYPTION_KEY").map_err(|_| anyhow!("APP_ENCRYPTION_KEY is required; reuse original 32-byte base64 key"))?)?;
    bytes.try_into().map_err(|_| anyhow!("APP_ENCRYPTION_KEY must decode to 32 bytes"))
}
pub fn hash_password(password: &str) -> Result<String> {
    if password.chars().count()<10 || password.len()>1024 { bail!("password must have at least 10 characters and at most 1024 UTF-8 bytes"); }
    let mut salt=[0u8;16]; OsRng.fill_bytes(&mut salt);
    let mut hash=[0u8;64];
    scrypt::scrypt(password.as_bytes(),&salt,&scrypt::Params::new(14,8,1,64)?,&mut hash)?;
    Ok(format!("scrypt:{}:{}",STANDARD.encode(salt),STANDARD.encode(hash)))
}
pub fn verify_password(password: &str, encoded: &str) -> Result<bool> {
    if password.len()>1024 { return Ok(false); }
    let parts:Vec<&str>=encoded.split(':').collect();
    if parts.len()!=3 || parts[0]!="scrypt" { return Ok(false); }
    let salt=STANDARD.decode(parts[1])?; let expected=STANDARD.decode(parts[2])?;
    if salt.len()!=16 || expected.len()!=64 { return Ok(false); }
    let mut actual=[0u8;64];
    scrypt::scrypt(password.as_bytes(),&salt,&scrypt::Params::new(14,8,1,64)?,&mut actual)?;
    Ok(bool::from(actual.ct_eq(expected.as_slice())))
}
pub fn encrypt(key: &[u8;32], text: &str) -> Result<String> {
    if text.len()>65536 { bail!("secret exceeds size limit"); }
    let mut iv=[0u8;12]; OsRng.fill_bytes(&mut iv);
    let cipher=Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("invalid encryption key"))?;
    let mut data=cipher.encrypt(Nonce::from_slice(&iv),text.as_bytes()).map_err(|_| anyhow!("encryption failed"))?;
    let tag=data.split_off(data.len()-16);
    Ok(format!("v1:{}:{}:{}",STANDARD.encode(iv),STANDARD.encode(tag),STANDARD.encode(data)))
}
pub fn decrypt(key: &[u8;32], encoded: &str) -> Result<String> {
    let parts:Vec<&str>=encoded.split(':').collect();
    if parts.len()!=4 || parts[0]!="v1" { bail!("unsupported encrypted format"); }
    let iv=STANDARD.decode(parts[1])?; let tag=STANDARD.decode(parts[2])?;
    if iv.len()!=12 || tag.len()!=16 { bail!("invalid nonce/tag length"); }
    let mut data=STANDARD.decode(parts[3])?;
    if data.len()>65536 { bail!("secret exceeds limit"); }
    data.extend_from_slice(&tag);
    let cipher=Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("invalid encryption key"))?;
    String::from_utf8(cipher.decrypt(Nonce::from_slice(&iv),data.as_ref()).map_err(|_| anyhow!("authentication failed"))?).map_err(Into::into)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn password_roundtrip() { let h=hash_password("test-password-123").unwrap(); assert!(verify_password("test-password-123",&h).unwrap()); assert!(!verify_password("wrong",&h).unwrap()); }
    #[test] fn secret_roundtrip_and_tamper() { let e=encrypt(&[3;32],"Cookie=secret;中文").unwrap(); assert_eq!(decrypt(&[3;32],&e).unwrap(),"Cookie=secret;中文"); assert!(decrypt(&[4;32],&e).is_err()); assert!(decrypt(&[3;32],"v1:AA==:AA==:AA==").is_err()); }
}
