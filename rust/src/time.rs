use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn local_date(instant:&str,zone:&str)->Result<NaiveDate> {
    let tz:Tz=zone.parse().map_err(|_|anyhow::anyhow!("invalid IANA timezone"))?;
    Ok(DateTime::parse_from_rfc3339(instant)?.with_timezone(&tz).date_naive())
}
pub fn local_instant(date:&str,time:&str,zone:&str)->Result<String> {
    let day=NaiveDate::parse_from_str(date,"%Y-%m-%d")?;
    let time=NaiveTime::parse_from_str(time,"%H:%M")?;
    let tz:Tz=zone.parse().map_err(|_|anyhow::anyhow!("invalid IANA timezone"))?;
    let value=tz.from_local_datetime(&day.and_time(time)).single().context("ambiguous/nonexistent DST local time requires review")?;
    Ok(value.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
}
pub fn relative_context(text:&str,published:&str,zone:&str)->Result<Value> {
    let tz:Tz=zone.parse().map_err(|_|anyhow::anyhow!("invalid timezone"))?;
    let value=DateTime::parse_from_rfc3339(published)?.with_timezone(&tz);
    let day=value.date_naive(); let early=value.hour()<4;
    let mut tomorrow=Vec::new();
    if text.contains("明天") || text.contains("明晚") {
        tomorrow.push(json!({"date":(day+Duration::days(1)).to_string(),"basis":"calendar_day"}));
        if early { tomorrow.push(json!({"date":day.to_string(),"basis":"possible_sleep_day"})); }
    }
    let monday=day-Duration::days(day.weekday().num_days_from_monday() as i64);
    let mut weeks=Vec::new();
    if text.contains("下周") {
        weeks.push(json!({"monday":(monday+Duration::days(7)).to_string(),"basis":"calendar_next_week"}));
        if early && day.weekday().num_days_from_monday()==0 { weeks.push(json!({"monday":monday.to_string(),"basis":"possible_sunday_sleep_day"})); }
    } else if text.contains("本周") || text.contains("这周") || text.contains("周表") {
        weeks.push(json!({"monday":monday.to_string(),"basis":"publication_week"}));
        if day.weekday().num_days_from_monday()>=5 { weeks.push(json!({"monday":(monday+Duration::days(7)).to_string(),"basis":"possible_upcoming_week"})); }
    }
    Ok(json!({"publicationLocal":value.to_rfc3339(),"tomorrowCandidates":tomorrow,"weekCandidates":weeks,
        "ambiguous":tomorrow.len()>1 || weeks.len()>1,"rule":"Explicit dates/weekday evidence take precedence; do not pick a candidate only to make a time future."}))
}
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Entry {
    pub occurrence_date:Option<String>, pub weekday:Option<u32>, pub local_time:Option<String>,
    pub status:String, #[serde(default)] pub title:String,
    pub confidence:u8, #[serde(default)] pub source_text:String,
}
pub fn validate_entries(entries:&[Entry], monday:Option<&str>,zone:&str)->Result<Vec<(String,Option<String>)>> {
    if entries.is_empty() || entries.len()>70 { bail!("schedule must contain 1..70 entries"); }
    let anchor=monday.map(|s|NaiveDate::parse_from_str(s,"%Y-%m-%d")).transpose()?;
    if anchor.is_some_and(|d|d.weekday().num_days_from_monday()!=0) { bail!("week anchor must be a Monday"); }
    let mut result=Vec::new();
    for entry in entries {
        if entry.confidence>100 || entry.title.len()>800 || entry.source_text.len()>2000 { bail!("invalid schedule entry"); }
        if !["scheduled","delayed","cancelled"].contains(&entry.status.as_str()) { bail!("unsupported schedule status"); }
        if entry.weekday.is_some_and(|n|!(1..=7).contains(&n)) { bail!("weekday outside 1..7"); }
        let date=if let Some(date)=&entry.occurrence_date { NaiveDate::parse_from_str(date,"%Y-%m-%d")? }
            else { anchor.context("weekday-only schedule requires explicit Monday approval")?+Duration::days(entry.weekday.context("missing date/weekday")? as i64-1) };
        if entry.weekday.is_some_and(|n|n!=date.weekday().number_from_monday()) { bail!("date and weekday disagree"); }
        let start=match entry.local_time.as_deref() {
            Some(t)=>Some(local_instant(&date.to_string(),t,zone)?),
            None if entry.status=="cancelled"=>None,
            None=>bail!("unknown scheduled/delayed time must remain in review"),
        };
        result.push((date.to_string(),start));
    }
    Ok(result)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn midnight_is_not_forcibly_shifted() { let v=relative_context("明天20点播","2026-09-12T17:30:00Z","Asia/Shanghai").unwrap(); assert_eq!(v["tomorrowCandidates"][0]["date"],"2026-09-14"); assert_eq!(v["tomorrowCandidates"][1]["date"],"2026-09-13"); }
    #[test] fn monday_early_next_week_has_two_candidates() { let v=relative_context("下周周表","2026-09-13T17:00:00Z","Asia/Shanghai").unwrap(); assert_eq!(v["weekCandidates"].as_array().unwrap().len(),2); }
    #[test] fn publication_not_machine_timezone() { assert_eq!(local_date("2026-09-12T17:00:00Z","Asia/Shanghai").unwrap().to_string(),"2026-09-13"); }
    #[test] fn dst_gap_and_fold_require_review() { assert!(local_instant("2026-03-08","02:30","America/Los_Angeles").is_err()); assert!(local_instant("2026-11-01","01:30","America/Los_Angeles").is_err()); }
    #[test] fn precise_conversion() { assert_eq!(local_instant("2026-09-14","20:00","Asia/Shanghai").unwrap(),"2026-09-14T12:00:00.000Z"); }
}
