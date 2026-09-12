#!/usr/bin/env python3
"""Real Rust HTTP server acceptance replay. Bilibili and AI are local deterministic
mocks, not live accounts. The Rust process is optionally confined to a 150-MiB,
one-core, zero-swap cgroup; the external load generator and mocks are excluded.
"""
from __future__ import annotations
import argparse, base64, concurrent.futures, datetime as dt, hashlib, http.server, json, os, pathlib, sqlite3, subprocess, tempfile, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from harness import Process, free_port, MIB

UTC=dt.timezone.utc

def iso(when=None):
    return (when or dt.datetime.now(UTC)).isoformat(timespec='milliseconds').replace('+00:00','Z')

class Mock(http.server.BaseHTTPRequestHandler):
    calls={}; feed=[]; fail_feed=False; planned=iso(dt.datetime.now(UTC)+dt.timedelta(days=1))
    image=bytes.fromhex('89504e470d0a1a0a') + b'A'*(3*1024*1024-8)
    def log_message(self,*args): pass
    def send_json(self,body,status=200):
        data=json.dumps(body,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        path=urllib.parse.urlsplit(self.path).path;Mock.calls[path]=Mock.calls.get(path,0)+1
        if path.endswith('.png'):
            self.send_response(200);self.send_header('Content-Type','image/png');self.send_header('Content-Length',str(len(self.image)));self.end_headers()
            try:
                for start in range(0,len(self.image),65536):self.wfile.write(self.image[start:start+65536])
            except (BrokenPipeError,ConnectionResetError):pass
            return
        if path.endswith('/feed/space'):
            if self.fail_feed:self.send_json({'code':-412},412);return
            self.send_json({'code':0,'data':{'items':self.feed,'has_more':False,'offset':''}});return
        if path.endswith('/nav'):
            self.send_json({'code':0,'data':{'isLogin':True,'wbi_img':{'img_url':'https://i0.hdslb.com/'+'a'*32+'.png','sub_url':'https://i0.hdslb.com/'+'b'*32+'.png'}}});return
        if 'get_status_info_by_uids' in path:
            self.send_json({'code':0,'data':{'123':{'uid':123,'room_id':456,'short_id':0,'live_status':0,'title':'Replay'}}});return
        if '/reply/' in path:
            self.send_json({'code':0,'data':{'replies':[],'top_replies':[],'cursor':{'is_end':True,'pagination_reply':{'next_offset':''}}}});return
        self.send_json({'error':'unknown mock path'},404)
    def do_POST(self):
        path=urllib.parse.urlsplit(self.path).path;Mock.calls[path]=Mock.calls.get(path,0)+1
        length=int(self.headers.get('Content-Length','0'));payload=json.loads(self.rfile.read(length))
        if path.endswith('/chat/completions'):
            prompt=json.dumps(payload,ensure_ascii=False)
            if 'currentUserRequest' in prompt:
                result={'answer':'已读取配置，没有执行修改。','actions':[]}
            else:
                result={'events':[{'eventType':'scheduled','plannedStartAt':self.planned,'confidence':90,'title':'明确开播','sourceText':'明确日期','needsReview':False}],
                        'scheduleEntries':[{'occurrenceDate':self.planned[:10],'weekday':None,'localTime':'20:00','status':'scheduled','title':'图文周表','confidence':90,'sourceText':'20:00'}]}
            self.send_json({'choices':[{'message':{'content':json.dumps(result,ensure_ascii=False)}}],
                            'usage':{'prompt_tokens':100,'completion_tokens':40,'prompt_tokens_details':{'cached_tokens':20}}});return
        self.send_json({'error':'unknown mock path'},404)

def main(args):
    binary=pathlib.Path(args.binary).resolve();out=pathlib.Path('rust/results');out.mkdir(parents=True,exist_ok=True)
    checks=[];requests=[];process=None;stop_sampling=threading.Event();sample_thread=None;reports=[]
    mock=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=mock.serve_forever,daemon=True).start()
    def check(name,value):
        if not value:raise AssertionError(name)
        checks.append(name);print('PASS '+name,flush=True)
    try:
      with tempfile.TemporaryDirectory(prefix='vtbm-acceptance-') as temp:
        root=pathlib.Path(temp);port=free_port();management=free_port();origin=f'http://127.0.0.1:{port}';cookie=''
        env={**os.environ,'DATA_DIR':str(root),'PORT':str(port),'MANAGEMENT_PORT':str(management),'HOST':'127.0.0.1','ORIGIN':origin,
             'APP_ENCRYPTION_KEY':base64.b64encode(b'T'*32).decode(),'ADMIN_INITIAL_PASSWORD':'initial-password-123',
             'DISABLE_SCHEDULER':'1','VTBM_TEST_MODE':'1','BILI_MOCK_ORIGIN':f'http://127.0.0.1:{mock.server_port}', 'MALLOC_ARENA_MAX':'2'}
        for name in ('DATABASE_PATH','MEDIA_DIR'):env.pop(name,None)
        def start(label):
            nonlocal process,sample_thread,stop_sampling
            process=Process([str(binary)],env,out/label,args.memory_mib)
            stop_sampling=threading.Event()
            def sample():
                while not stop_sampling.wait(.01):process.sample()
            sample_thread=threading.Thread(target=sample,daemon=True);sample_thread.start()
            for _ in range(200):
                if process.process.poll() is not None:raise RuntimeError(process.log_path.read_text(errors='replace'))
                try:
                    with urllib.request.urlopen(origin+'/healthz',timeout=.5) as r:
                        if r.status==200:return
                except (OSError,urllib.error.URLError):time.sleep(.05)
            raise RuntimeError('server did not start')
        def stop(label):
            nonlocal process
            if process:
                stop_sampling.set()
                if sample_thread:sample_thread.join(timeout=2)
                report=process.close();report['phase']=label;reports.append(report)
                (out/(label+'-samples.json')).write_text(json.dumps(process.samples));process=None
        def request(path,method='GET',body=None,expected=200,headers=None,management_api=False):
            nonlocal cookie
            target=(f'http://127.0.0.1:{management}/v1/' if management_api else origin+'/api/v1/')+path
            h={'Origin':origin,**({'Cookie':cookie} if cookie and not management_api else {}),**(headers or {})}
            if body is not None:h['Content-Type']='application/json'
            before=time.perf_counter();req=urllib.request.Request(target,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h)
            try:r=urllib.request.urlopen(req,timeout=45)
            except urllib.error.HTTPError as e:r=e
            raw=r.read();status=r.status
            if r.headers.get('Set-Cookie'):cookie=r.headers['Set-Cookie'].split(';',1)[0]
            try:data=json.loads(raw)
            except ValueError:data=raw.decode(errors='replace')
            requests.append({'path':path,'status':status,'ms':round((time.perf_counter()-before)*1000,3)})
            if status!=expected:raise AssertionError(f'{method} {path}: expected {expected}, got {status}: {data}')
            return data
        start('http-api')
        request('login','POST',{'username':'admin','password':'initial-password-123'},403,{'Origin':'https://evil.invalid'})
        check('cross-origin login rejected',True)
        login=request('login','POST',{'username':'admin','password':'initial-password-123'});check('initial password requires rotation',login['forcePasswordChange'])
        request('status',expected=403);check('forced password rotation blocks admin operations',True)
        request('password','POST',{'password':'replacement-password-123'})
        request('me',expected=401);check('password change invalidates sessions',True)
        request('login','POST',{'username':'admin','password':'replacement-password-123'})
        body={'name':'测试主播','slug':'test-streamer','biliUid':'123','roomId':'456','enabled':False}
        sid=request('streamers','POST',body)['id'];check('streamer creation',bool(sid))
        s=request('streamers/'+sid)['data'];check('streamer read',s['name']=='测试主播')
        request('streamers/'+sid,'PATCH',{'version':s['version'],'name':'修订名称'})
        request('streamers/'+sid,'PATCH',{'version':s['version'],'name':'stale'},409);check('optimistic concurrency',True)
        token=request('tokens','POST',{'name':'readonly','scopes':['status:read']})
        auth={'Authorization':'Bearer '+token['token']}
        request('status',headers=auth,management_api=True)
        request('streamers','POST',body,403,{**auth,'Idempotency-Key':'forbidden'},True);check('bearer scope enforced',True)
        writer=request('tokens','POST',{'name':'writer','scopes':['config:read','config:write','ops:run','status:read']})
        wauth={'Authorization':'Bearer '+writer['token'],'Idempotency-Key':'same-create'}
        second={**body,'slug':'second','biliUid':'124','roomId':'457'}
        first=request('streamers','POST',second,headers=wauth,management_api=True)
        repeated=request('streamers','POST',second,headers=wauth,management_api=True)
        check('management write idempotency',first==repeated)
        request('streamers','POST',{**second,'name':'different'},409,wauth,True);check('idempotency request mismatch rejected',True)
        request('tokens/'+token['id']+'/revoke','POST',{})
        request('status',expected=401,headers=auth,management_api=True);check('token revocation',True)
        request('secrets/pi_api_key','POST',{'value':'fixture-api-key'})
        request('settings/pi_profile','POST',{'value':{'provider':'openai','modelId':'fixture-model','baseUrl':f'http://127.0.0.1:{mock.server_port}/v1','input':['text','image']}})
        secrets=request('secrets')['data'];check('secret listing does not expose ciphertext or plaintext',all('encrypted_value' not in s and 'value' not in s for s in secrets))
        dbpath=root/'vtb-monitor.sqlite'
        # Verify Rust ciphertext using the original Node AES-GCM byte layout.
        with sqlite3.connect(dbpath) as db:encrypted=db.execute("SELECT encrypted_value FROM secrets WHERE key='pi_api_key'").fetchone()[0]
        js="const c=require('node:crypto');const [v,i,t,d]=process.argv[1].split(':');const x=c.createDecipheriv('aes-256-gcm',Buffer.alloc(32,84),Buffer.from(i,'base64'));x.setAuthTag(Buffer.from(t,'base64'));console.log(Buffer.concat([x.update(Buffer.from(d,'base64')),x.final()]).toString());"
        decrypted=subprocess.check_output(['node','-e',js,encrypted],text=True).strip();check('Rust secret readable by original Node crypto',decrypted=='fixture-api-key')
        node_hash=subprocess.check_output(['node','-e',"const c=require('node:crypto');const salt=Buffer.alloc(16,7);console.log('scrypt:'+salt.toString('base64')+':'+c.scryptSync('node-legacy-password',salt,64).toString('base64'))"],text=True).strip()
        with sqlite3.connect(dbpath) as db:db.execute('UPDATE admins SET password_hash=?',(node_hash,))
        request('logout','POST',{});request('login','POST',{'username':'admin','password':'node-legacy-password'});check('legacy Node scrypt accepted by Rust',True)
        timestamp=iso();did='90000000000000000001';mediaid='fixture-media';imagepath=root/'media'/'fixture.png';imagepath.write_bytes(Mock.image)
        with sqlite3.connect(dbpath) as db:
            for i in range(65):db.execute('INSERT INTO dynamics(id,streamer_id,type,text,source_url,published_at,updated_at,last_seen_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?)',(str(90000000000000000001+i),sid,'DYNAMIC_TYPE_DRAW','归档正文 '+str(i),'https://t.bilibili.com/'+str(i),timestamp,timestamp,timestamp,'hash-'+str(i)))
            db.execute("INSERT INTO media_assets(id,source_url,sha256,local_path,mime_type,byte_size,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'stored',?,?)",(mediaid,'https://i0.hdslb.com/fixture.png',hashlib.sha256(Mock.image).hexdigest(),'fixture.png','image/png',len(Mock.image),timestamp,timestamp))
            db.execute('INSERT INTO dynamic_media VALUES(?,?,?,?)',(did,mediaid,0,'https://i0.hdslb.com/fixture.png'))
            db.execute('INSERT INTO dynamic_revisions(id,dynamic_id,text,content_hash,snapshot_json,created_at) VALUES(?,?,?,?,?,?)',('revision-1',did,'旧正文','oldhash','{}',timestamp))
            db.execute('INSERT INTO comments(id,dynamic_id,author_uid,author_name,message,content_hash,published_at,updated_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?)',('comment-1',did,'123','测试主播','补充评论','comment-hash',timestamp,timestamp,timestamp))
        ids=[];cursor=None
        while True:
            r=request('streamers/'+sid+'/dynamics?limit=20'+('&cursor='+urllib.parse.quote(cursor) if cursor else ''));ids.extend(v['id'] for v in r['data']);cursor=r['nextCursor']
            if not cursor:break
        check('65 same-timestamp dynamics paginated without duplicates or loss',len(ids)==65 and len(set(ids))==65)
        check('archive revisions preserved',request('dynamics/'+did+'/revisions')['data'][0]['text']=='旧正文')
        check('comments visible',request('dynamics/'+did+'/comments')['data'][0]['message']=='补充评论')
        with urllib.request.urlopen(origin+'/media/'+mediaid) as r:actual=r.read()
        check('streamed local image byte-for-byte identical',hashlib.sha256(actual).digest()==hashlib.sha256(Mock.image).digest())
        with urllib.request.urlopen(origin+'/api/image-proxy/https://i0.hdslb.com/fixture.png') as r:actual=r.read()
        check('streamed image proxy byte-for-byte identical',actual==Mock.image)
        try:urllib.request.urlopen(origin+'/api/image-proxy/https://127.0.0.1/private')
        except urllib.error.HTTPError as e:check('image proxy rejects untrusted host',e.code==403)
        day=(dt.datetime.now(UTC)+dt.timedelta(days=1)).date();weekday=day.isoweekday()
        request('streamers/'+sid+'/rules','POST',{'rules':[{'weekday':weekday,'localTime':'20:00','title':'固定安排'}]})
        check('fixed rule creates future forecast',request('streamers/'+sid)['forecast'] is not None)
        entries=[{'occurrenceDate':day.isoformat(),'weekday':weekday,'localTime':None,'status':'cancelled','title':'休息','confidence':100,'sourceText':'休息'}]
        with sqlite3.connect(dbpath) as db:db.execute("INSERT INTO schedule_drafts(id,streamer_id,dynamic_id,content_hash,source_text,media_urls_json,status,entries_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'review',?,?,?)",('draft-1',sid,did,'hash-0','周表','[]',json.dumps(entries),timestamp,timestamp))
        confirmed=request('drafts/draft-1/confirm','POST',{});check('schedule cancellation draft confirmed',confirmed['confirmed']==1)
        check('confirming draft is idempotent',request('drafts/draft-1/confirm','POST',{})==confirmed)
        with sqlite3.connect(dbpath) as db:
            exception=db.execute("SELECT status,start_at FROM schedule_exceptions WHERE streamer_id=?",(sid,)).fetchone()
        check('cancelled entry has no fabricated start time',exception==('cancelled',None))
        request('chat','POST',{'prompt':'只读取当前状态，不修改','conversationId':'fixture-conversation'})
        history=request('chat/fixture-conversation')['data'];check('admin chat persisted without binary messages',len(history)==2)
        # Enqueue a real acquisition->media->AI->draft cycle using the deterministic mock.
        feedid='99900000000000000001'
        Mock.feed=[{'id_str':feedid,'type':'DYNAMIC_TYPE_DRAW','basic':{'comment_id_str':feedid,'comment_type':17},'modules':{'module_author':{'pub_ts':int(time.time())},'module_dynamic':{'desc':{'text':'明确日期开播，图文安排'},'major':{'draw':{'items':[{'src':'https://i0.hdslb.com/new.png'}]}}},'module_stat':{'comment':{'count':0},'like':{'count':0}}}}]
        s=request('streamers/'+sid)['data'];request('streamers/'+sid,'PATCH',{'version':s['version'],'enabled':True})
        stop('http-api');env['DISABLE_SCHEDULER']='0';env.pop('ADMIN_INITIAL_PASSWORD',None);start('worker-replay')
        deadline=time.monotonic()+100
        while time.monotonic()<deadline:
            with sqlite3.connect(dbpath) as db:
                db.execute("UPDATE jobs SET due_at=? WHERE type='rs_analyze_dynamic' AND status IN ('pending','retry')",(iso(dt.datetime.now(UTC)-dt.timedelta(seconds=1)),))
                found=db.execute('SELECT COUNT(*) FROM pi_dynamic_analysis_versions WHERE dynamic_id=?',(feedid,)).fetchone()[0]
            if found:break
            time.sleep(.3)
        check('real worker acquisition, media and AI extraction completes',bool(found))
        with sqlite3.connect(dbpath) as db:
            draft=db.execute('SELECT status FROM schedule_drafts WHERE dynamic_id=?',(feedid,)).fetchone()
            usage=db.execute("SELECT input_tokens,output_tokens,cache_read_tokens FROM ai_usage WHERE purpose='dynamic-extraction' ORDER BY created_at DESC LIMIT 1").fetchone()
            before=Mock.calls.get('/v1/chat/completions',0)
            stamp=iso();db.execute("INSERT INTO jobs(id,type,entity_id,payload_json,priority,due_at,dedupe_key,created_at,updated_at) VALUES(?,'rs_analyze_dynamic',?,'{}',1,?,?,?,?)",(str(uuid.uuid4()),feedid,stamp,str(uuid.uuid4()),stamp,stamp))
        check('visual extraction yields reviewable schedule draft',draft==('review',))
        check('provider token usage recorded',usage==(100,40,20))
        time.sleep(3);check('identical source uses result cache without another model call',Mock.calls.get('/v1/chat/completions',0)==before)
        # Repeat a realistic bounded HTTP mix while the scheduler remains active.
        failures=[]
        def read_mix(i):
            path='/api/v1/streamers' if i%3==0 else '/api/v1/dynamics/'+did if i%3==1 else '/media/'+mediaid
            before=time.perf_counter()
            try:
                with urllib.request.urlopen(origin+path,timeout=20) as r:
                    while r.read(65536):pass
                return (r.status,(time.perf_counter()-before)*1000)
            except urllib.error.HTTPError as e:return(e.code,(time.perf_counter()-before)*1000)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:mixed=list(pool.map(read_mix,range(120)))
        check('mixed load completes without internal errors',all(code in (200,503) for code,_ in mixed) and sum(code==200 for code,_ in mixed)>=100)
        with sqlite3.connect(dbpath) as db:db.execute('PRAGMA wal_checkpoint(PASSIVE)')
        stop('worker-replay')
        # Copy migrates from a read-only source and cannot overwrite the destination.
        target=root/'copy.sqlite';subprocess.run([str(binary),'migrate-copy',str(dbpath),str(target)],env=env,check=True,capture_output=True,text=True)
        with sqlite3.connect(target) as db:check('copy migration preserves archived dynamics',db.execute('SELECT COUNT(*) FROM dynamics').fetchone()[0]>=66)
        r=subprocess.run([str(binary),'migrate-copy',str(dbpath),str(target)],env=env,capture_output=True);check('copy migration refuses overwrite',r.returncode!=0)
        for report in reports:
            if args.memory_mib:
                check(report['phase']+' enforced cgroup budget',report['limitEnforced'] and report['cgroupPeakBytes']<=args.memory_mib*MIB and report['memoryEvents'].get('oom_kill',0)==0)
        result={'passed':True,'checks':checks,'checkCount':len(checks),'requests':requests,'processes':reports,'mixedLoad':mixed,
                'externalCalls':Mock.calls,'memoryLimitMiB':args.memory_mib or None,'claimBoundary':'Deterministic HTTP and worker replay; not real Bilibili/paid-model or full legacy UI parity verification.'}
        (out/'acceptance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print('ACCEPTANCE_SUMMARY='+json.dumps({'checks':len(checks),'processes':reports},ensure_ascii=False),flush=True)
    except Exception as error:
        if process:
            print(process.log_path.read_text(errors='replace'),flush=True)
        (out/'acceptance-failure.json').write_text(json.dumps({'passed':False,'checks':checks,'error':repr(error),'requests':requests},ensure_ascii=False,indent=2))
        raise
    finally:
        stop_sampling.set()
        if sample_thread:sample_thread.join(timeout=2)
        if process:process.close()
        mock.shutdown();mock.server_close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--memory-mib',type=int,default=0);main(p.parse_args())
