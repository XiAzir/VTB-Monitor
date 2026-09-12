use anyhow::{anyhow, bail, Context, Result};
use chrono::{TimeZone, Utc};
use rusqlite::params;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use crate::{db::{self, *}, limits, security};

#[derive(Clone)] pub struct Bili {
    pub db:Db, pub client:reqwest::Client, pub key:[u8;32],
    next:Arc<Mutex<tokio::time::Instant>>, wbi:Arc<Mutex<Option<(i64,String)>>>,
    pub mock_origin:Option<String>,
}
impl Bili {
    pub fn new(db:Db,client:reqwest::Client,key:[u8;32],mock_origin:Option<String>)->Self {
        Self{db,client,key,next:Arc::new(Mutex::new(tokio::time::Instant::now())),wbi:Arc::new(Mutex::new(None)),mock_origin}
    }
    pub async fn cookie(&self)->Result<Option<String>> {
        let key=self.key;
        self.db.call(move|db|{
            let row=one(db,"SELECT encrypted_value FROM secrets WHERE (key='bilibili_cookie' OR key LIKE 'bilibili_cookie_pool:%') AND status!='invalid' ORDER BY CASE WHEN key='bilibili_cookie' THEN 0 ELSE 1 END,key LIMIT 1",&[])?;
            if row.is_null(){Ok(None)}else{security::decrypt(&key,strv(&row,"encrypted_value")).map(Some)}
        }).await
    }
    async fn response(&self,url:&str)->Result<reqwest::Response>{
        let cool=self.db.call(|db|one(db,"SELECT value FROM rs_meta WHERE key='bilibili-cooldown'",&[])).await?;
        if strv(&cool,"value")>now().as_str(){bail!("COOLDOWN: Bilibili circuit is open");}
        let mut next=self.next.lock().await;
        tokio::time::sleep_until(*next).await;
        *next=tokio::time::Instant::now()+Duration::from_millis(if self.mock_origin.is_some(){1}else{2500});
        let mut target=url::Url::parse(url)?;
        if let Some(origin)=&self.mock_origin{let original_path=target.path().to_string();let query=target.query().map(String::from);target=url::Url::parse(&format!("{}{}",origin,original_path))?;target.set_query(query.as_deref());}
        let mut request=self.client.get(target).header("referer","https://www.bilibili.com/");
        if let Some(cookie)=self.cookie().await?{request=request.header("cookie",cookie);}
        let response=request.send().await?;
        if [412,429].contains(&response.status().as_u16()){
            self.cool(3600).await?;bail!("COOLDOWN: upstream rejected request");
        }
        if !response.status().is_success(){bail!("Bilibili HTTP {}",response.status().as_u16());}
        Ok(response)
    }
    async fn cool(&self,seconds:i64)->Result<()> {
        self.db.call(move|db|{db.execute("INSERT INTO rs_meta(key,value) VALUES('bilibili-cooldown',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",[after(seconds)])?;Ok(())}).await
    }
    pub async fn json(&self,url:&str)->Result<Value>{
        let data=limits::json(self.response(url).await?).await?;
        let code=number(&data,"code",0);
        if [-412,-352,412,429].contains(&code){self.cool(3600).await?;bail!("COOLDOWN: Bilibili API code {code}");}
        if code!=0{bail!("Bilibili API code {code}");}
        Ok(data["data"].clone())
    }
    pub async fn signed(&self,path:&str,mut args:BTreeMap<String,String>)->Result<Value>{
        let mut cached=self.wbi.lock().await;
        let timestamp=Utc::now().timestamp();
        if cached.as_ref().is_none_or(|(expires,_)|*expires<timestamp){
            let data=self.json("https://api.bilibili.com/x/web-interface/nav").await?;
            let basename=|s:&str|s.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("").to_owned();
            let raw=basename(strv(&data["wbi_img"],"img_url"))+&basename(strv(&data["wbi_img"],"sub_url"));
            let table=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
            if raw.len()<64 || !raw.is_ascii(){bail!("invalid WBI key");}
            let key:String=table.iter().take(32).map(|&i|raw.as_bytes()[i] as char).collect();*cached=Some((timestamp+3600,key));
        }
        let key=cached.as_ref().unwrap().1.clone();drop(cached);
        args.insert("wts".into(),timestamp.to_string());
        let mut query=url::form_urlencoded::Serializer::new(String::new());
        for (key,value) in args {let clean:String=value.chars().filter(|c|!"!'()*".contains(*c)).collect();query.append_pair(&key,&clean);}
        let query=query.finish().replace('+',"%20");let signature=format!("{:x}",md5::compute(format!("{query}{key}")));
        self.json(&format!("https://api.bilibili.com{path}?{query}&w_rid={signature}")).await
    }
    pub async fn detail(&self,did:&str)->Result<Value>{
        let response=self.response(&format!("https://www.bilibili.com/opus/{did}")).await?;
        let bytes=limits::read_bounded(response,4*1024*1024).await?;let html=std::str::from_utf8(&bytes)?;
        if html.contains("window._biligreyresult") || html.contains("请先完成验证") || html.contains("验证码_哔哩哔哩"){self.cool(3600).await?;bail!("COOLDOWN: challenge page");}
        let state=initial_state(html)?;let detail=&state["detail"];
        let modules=detail["modules"].as_array().context("detail unavailable; deletion not confirmed")?;
        let mut text=Vec::new();let mut urls=Vec::new();let mut emojis=serde_json::Map::new();
        for m in modules {
            if let Some(paragraphs)=m["module_content"]["paragraphs"].as_array(){for p in paragraphs{
                if let Some(nodes)=p["text"]["nodes"].as_array(){let mut parts=String::new();for n in nodes{
                    parts.push_str(n["word"]["words"].as_str().or(n["rich"]["orig_text"].as_str()).or(n["text"].as_str()).unwrap_or(""));
                    if let (Some(k),Some(v))=(n["rich"]["emoji"]["text"].as_str(),n["rich"]["emoji"]["icon_url"].as_str()){emojis.insert(k.into(),json!(v));}
                }text.push(parts);}
                collect_images(p,&mut urls,0);
            }}
            collect_images(&m["module_top"]["display"]["album"]["pics"],&mut urls,0);
        }
        urls.sort();urls.dedup();
        Ok(json!({"text":text.join("\n"),"mediaUrls":urls,"emojiMap":emojis,
            "commentOid":id_string(&detail["basic"]["comment_id_str"]),"commentType":id_string(&detail["basic"]["comment_type"])}))
    }
}
pub fn id_string(v:&Value)->String{v.as_str().map(String::from).unwrap_or_else(||if v.is_number(){v.to_string()}else{String::new()})}
pub fn epoch(v:&Value)->String{Utc.timestamp_opt(v.as_i64().unwrap_or(0),0).single().unwrap_or_else(Utc::now).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
fn collect_images(v:&Value,out:&mut Vec<String>,depth:usize){
    if depth>12 || out.len()>=100{return;}
    match v {Value::Array(a)=>for x in a{collect_images(x,out,depth+1)},Value::Object(m)=>for (k,x) in m{
        if ["url","src"].contains(&k.as_str()){if let Some(s)=x.as_str(){if s.contains("hdslb.com/"){out.push(if s.starts_with("//"){format!("https:{s}")}else{s.into()});}}}
        else if !["emoji","avatar","face"].contains(&k.as_str()){collect_images(x,out,depth+1)}
    },_=>{}}
}
pub fn normalize_dynamic(item:&Value)->Result<Value>{
    let did=id_string(&item["id_str"]);if did.is_empty(){bail!("missing dynamic id");}
    let module=&item["modules"]["module_dynamic"];let major=&module["major"];
    let description=if module["desc"].is_object(){&module["desc"]}else{&major["opus"]["summary"]};
    let text=description["text"].as_str().unwrap_or("");
    let mut images=Vec::new();collect_images(&major["draw"]["items"],&mut images,0);collect_images(&major["opus"]["pics"],&mut images,0);
    if let Some(s)=major["archive"]["cover"].as_str(){images.push(s.into());}
    if let Some(covers)=major["article"]["covers"].as_array(){for c in covers{if let Some(s)=c.as_str(){images.push(s.into());}}}
    let mut emoji=serde_json::Map::new();if let Some(nodes)=description["rich_text_nodes"].as_array(){for n in nodes{if let (Some(k),Some(v))=(n["text"].as_str(),n["emoji"]["icon_url"].as_str()){emoji.insert(k.into(),json!(v));}}}
    let mut card=Value::Null;
    if major["archive"].is_object(){let a=&major["archive"];card=json!({"kind":"video","bvid":a["bvid"],"title":a["title"],"description":a["desc"],"coverUrl":a["cover"],"jumpUrl":a["jump_url"],"durationText":a["duration_text"],"viewCount":a["stat"]["play"],"danmakuCount":a["stat"]["danmaku"]});}
    if item["orig"].is_object(){let original=&item["orig"];card=json!({"kind":"forward","text":original["modules"]["module_dynamic"]["desc"]["text"],"authorName":original["modules"]["module_author"]["name"],"authorUid":id_string(&original["modules"]["module_author"]["mid"]),"dynamicId":id_string(&original["id_str"]),"raw":original["modules"]["module_dynamic"]});}
    let comment_oid=major["opus"]["opus_id"].as_str().or(item["basic"]["comment_id_str"].as_str()).unwrap_or(&did);
    Ok(json!({"id":did,"type":item["type"],"text":text,"mediaUrls":images,"publishedAt":epoch(&item["modules"]["module_author"]["pub_ts"]),
       "commentOid":comment_oid,"commentType":id_string(&item["basic"]["comment_type"]),"commentCount":item["modules"]["module_stat"]["comment"]["count"],"likeCount":item["modules"]["module_stat"]["like"]["count"],
       "isPinned":item["modules"]["module_tag"]["text"].as_str()==Some("置顶"),"raw":{"emojiMap":emoji,"card":card},
       "detailRequired":major["opus"]["summary"]["is_text_truncated"].as_bool().unwrap_or(false)}))
}
pub fn normalize_comment(reply:&Value,root:Option<&str>)->Value{
    let mut urls=Vec::new();collect_images(&reply["content"]["pictures"],&mut urls,0);
    json!({"id":id_string(&reply["rpid_str"]).trim().to_owned().if_empty(id_string(&reply["rpid"])),"rootId":root,"parentId":id_string(&reply["parent_str"]),
      "authorUid":id_string(&reply["member"]["mid"]),"authorName":reply["member"]["uname"],"avatarUrl":reply["member"]["avatar"],"message":reply["content"]["message"],
      "likeCount":reply["like"],"replyCount":reply["rcount"],"publishedAt":epoch(&reply["ctime"]),"mediaUrls":urls,"isPinned":false})
}
trait IfEmpty{fn if_empty(self,other:String)->String;}
impl IfEmpty for String{fn if_empty(self,other:String)->String{if self.is_empty(){other}else{self}}}
pub fn initial_state(html:&str)->Result<Value>{
    let marker=html.find("window.__INITIAL_STATE__").context("missing initial state")?;
    let tail=&html[marker..];let equal=tail.find('=').context("missing assignment")?;let begin=tail[equal..].find('{').context("missing object")?+equal;
    let mut depth=0usize;let mut string=false;let mut escape=false;
    for (offset,c) in tail[begin..].char_indices(){
        if string{if escape{escape=false;}else if c=='\\'{escape=true;}else if c=='"'{string=false;}continue;}
        if c=='"'{string=true;}else if c=='{'{depth+=1;}else if c=='}'{depth=depth.checked_sub(1).context("unbalanced JSON")?;if depth==0{return Ok(serde_json::from_str(&tail[begin..begin+offset+1])?);}}
    }Err(anyhow!("incomplete initial state"))
}
#[cfg(test)]mod tests{use super::*;
    #[test]fn braces_in_strings(){let v=initial_state("<script>window.__INITIAL_STATE__={\"s\":\"}\\\"\",\"nested\":{\"n\":2}};x</script>").unwrap();assert_eq!(v["nested"]["n"],2);}
    #[test]fn truncated_state_rejected(){assert!(initial_state("window.__INITIAL_STATE__={\"x\":1").is_err());}
    #[test]fn identifiers_remain_strings(){assert_eq!(id_string(&json!("12345678901234567890")),"12345678901234567890");}
}
