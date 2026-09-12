#!/usr/bin/env python3
"""Original Pi SDK + Svelte routes through Rust. Only the provider is mocked.
The Rust process AND its Node child are measured in the SAME bounded cgroup.
"""
import argparse, base64, datetime, http.server, json, os, pathlib, sqlite3, subprocess, sys, tempfile, threading, time, urllib.error, urllib.parse, urllib.request, uuid
sys.path.insert(0, str(pathlib.Path('rust/tests').resolve()))
from harness import Process, free_port

class Model(http.server.BaseHTTPRequestHandler):
    calls=[]
    def log_message(self, *args): pass
    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        if n:
            raw = self.rfile.read(n)
        else:
            parts=[]
            while True:
                size=int(self.rfile.readline().strip(),16)
                if not size: self.rfile.readline(); break
                parts.append(self.rfile.read(size)); self.rfile.read(2)
            raw=b''.join(parts)
        body=json.loads(raw); names=[t['name'] for t in body.get('tools',[])]
        self.calls.append({'path':self.path,'tools':names,'bytes':len(raw)})
        messages=body.get('messages',[])
        tool_result=any(c.get('type')=='tool_result' for m in messages for c in (m.get('content',[]) if isinstance(m.get('content'),list) else []))
        self.send_response(200);self.send_header('content-type','text/event-stream');self.send_header('connection','close');self.end_headers()
        def emit(kind, payload):
            self.wfile.write(('event: '+kind+'\ndata: '+json.dumps({'type':kind,**payload},ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
        try:
            emit('message_start',{'message':{'id':'msg_fixture','type':'message','role':'assistant','model':body.get('model'),'content':[],
                'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':100,'output_tokens':0}}})
            if 'propose_schedule_draft' in names and not tool_result:
                entry={'occurrenceDate':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1)).strftime('%Y-%m-%d'),
                       'weekday':None,'localTime':'20:00','status':'scheduled','title':'原版 Pi 周表','confidence':95,'sourceText':'20:00'}
                emit('content_block_start',{'index':0,'content_block':{'type':'tool_use','id':'tool_fixture','name':'propose_schedule_draft','input':{}}})
                emit('content_block_delta',{'index':0,'delta':{'type':'input_json_delta','partial_json':json.dumps({'entries':[entry]},ensure_ascii=False)}})
                stop='tool_use'
            else:
                emit('content_block_start',{'index':0,'content_block':{'type':'text','text':''}})
                for text in ['第一段：原版 Pi。','第二段：流式回复完成。']:
                    emit('content_block_delta',{'index':0,'delta':{'type':'text_delta','text':text}});time.sleep(.3)
                stop='end_turn'
            emit('content_block_stop',{'index':0})
            emit('message_delta',{'delta':{'stop_reason':stop,'stop_sequence':None},'usage':{'output_tokens':20}})
            emit('message_stop',{})
        except (BrokenPipeError,ConnectionResetError):pass

def main(args):
    out=pathlib.Path('hybrid/results');out.mkdir(parents=True,exist_ok=True)
    mock=http.server.ThreadingHTTPServer(('127.0.0.1',0),Model)
    threading.Thread(target=mock.serve_forever,daemon=True).start()
    checks=[]; proc=None; stop=threading.Event();thread=None; report={}; completed=False; tempdir=None
    def check(name, condition):
        if not condition:raise AssertionError(name)
        checks.append(name); print('PASS',name,flush=True)
    try:
      tempdir=tempfile.TemporaryDirectory(prefix='hybrid-test-')
      temp=tempdir.name
      port=free_port();management=free_port();origin=f'http://127.0.0.1:{port}'
      env={**os.environ,'NODE_ENV':'development','HOST':'127.0.0.1','PORT':str(port),'MANAGEMENT_PORT':str(management),
           'ORIGIN':origin,'DATA_DIR':temp,'VTBM_APP_ROOT':str(pathlib.Path.cwd()),'VTBM_TEST_MODE':'1','DISABLE_SCHEDULER':'0',
           'VTBM_SIDECAR_IDLE_MS':'2000','ADMIN_INITIAL_PASSWORD':'hybrid-password-123',
           'APP_ENCRYPTION_KEY':base64.b64encode(b'H'*32).decode(),'MOCK_PI_ORIGIN':f'http://127.0.0.1:{mock.server_port}', 'MALLOC_ARENA_MAX':'2'}
      for key in ['DATABASE_PATH','MEDIA_DIR','VTBM_NATIVE_EXPERIMENTAL','BILI_MOCK_ORIGIN']:env.pop(key,None)
      seed=subprocess.run(['node','--import','tsx','hybrid/seed-pi.ts'],env=env,capture_output=True,text=True)
      (out/'seed.log').write_text(seed.stdout+'\n'+seed.stderr)
      seed.check_returncode()
      fixture=json.loads(seed.stdout.strip().splitlines()[-1]);dbpath=pathlib.Path(temp)/'vtb-monitor.sqlite'
      proc=Process([str(pathlib.Path(args.binary).resolve())],env,out/'process',args.memory_mib)
      def sample():
          while not stop.wait(.02):proc.sample()
      thread=threading.Thread(target=sample,daemon=True);thread.start()
      cookie=''
      def req(path, data=None, headers=None, base=origin):
          h={'Origin':origin,**({'Cookie':cookie} if cookie else {}),**(headers or {})}
          try:return urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers=h),timeout=90)
          except urllib.error.HTTPError as e:return e
      for _ in range(200):
          if proc.process.poll() is not None:raise RuntimeError(proc.log_path.read_text())
          try:
              if req('/healthz').status==200:break
          except OSError:time.sleep(.05)
      r=req('/');html=r.read().decode();check('original homepage served',r.status==200 and '主播监控' in html)
      class NoRedirect(urllib.request.HTTPRedirectHandler):
          def redirect_request(self,*a,**k):return None
      opener=urllib.request.build_opener(NoRedirect)
      try:r=opener.open(urllib.request.Request(origin+'/admin?/login',data=b'username=admin&password=hybrid-password-123',headers={'Origin':origin,'Content-Type':'application/x-www-form-urlencoded'}))
      except urllib.error.HTTPError as e:r=e
      cookie=(r.headers.get('Set-Cookie') or '').split(';',1)[0]
      check('original form login preserves Set-Cookie and redirect',r.status==303 and cookie.startswith('vtbm_session='))
      r=req('/admin');check('original admin server load',r.status==200 and '审核周表识别' in r.read().decode())
      r=req('/v1/healthz',base=f'http://127.0.0.1:{management}');check('management listener preserved',r.status==200 and json.load(r)['status']=='ok')
      r=req('/agent-api/v1/healthz',headers={'x-vtbm-management-listener':'internal-v1'});check('public management spoof rejected',r.status==404);r.read()
      r=req('/control/pi',json.dumps({'type':'pi_analyze','entityId':fixture['streamerId']}).encode(),{'Content-Type':'application/json'})
      check('private control endpoint not exposed publicly',r.status in (400,404,405));r.read()
      conversation=str(uuid.uuid4());start=time.monotonic()
      r=req('/admin/pi',json.dumps({'prompt':'请仅回复两句话','conversationId':conversation}).encode(),{'Content-Type':'application/json'})
      first=r.read(1);first_at=time.monotonic()-start;rest=r.read();elapsed=time.monotonic()-start;text=(first+rest).decode()
      (out/'pi-chat.txt').write_text(text)
      check('real TypeScript Pi streams before completion',r.status==200 and '第一段' in text and '第二段' in text and elapsed-first_at>.15)
      r=req('/admin/pi/history?id='+conversation);history=json.load(r)
      check('original Pi history survives through HTTP adapter',any('第一段' in m['text'] for m in history['messages']))
      def enqueue(kind, entity):
          con=sqlite3.connect(dbpath,timeout=10);jid=str(uuid.uuid4());ts=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
          con.execute('INSERT INTO jobs(id,type,entity_id,payload_json,status,priority,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                      (jid,kind,entity,'{}','pending',1,ts,ts,ts));con.commit();con.close();return jid
      jid=enqueue('recognize_schedule',fixture['draftId']);deadline=time.monotonic()+90
      while time.monotonic()<deadline:
          with sqlite3.connect(dbpath,timeout=10) as con:status=con.execute('SELECT status,last_error FROM jobs WHERE id=?',(jid,)).fetchone()
          if status[0]=='done':break
          if proc.process.poll() is not None:raise RuntimeError('Backend exited: '+proc.log_path.read_text())
          time.sleep(.1)
      (out/'schedule-job.json').write_text(json.dumps(status))
      check('Rust queue dispatches original Pi schedule recognition',status[0]=='done')
      with sqlite3.connect(dbpath) as con:
          row=con.execute('SELECT status,entries_json FROM schedule_drafts WHERE id=?',(fixture['draftId'],)).fetchone()
          check('original Pi tool call stores reviewable entries',row[0]=='review' and json.loads(row[1])[0]['title']=='原版 Pi 周表')
          check('new Pi history has no inline binary image blocks',not any('"type":"image"' in r[0] for r in con.execute('SELECT content_json FROM pi_messages')))
      check('9 MiB image actually reached Pi provider',any(c['bytes']>12*1024*1024 for c in Model.calls))
      time.sleep(4)
      events=proc.records();check('idle helper was reaped',any(e.get('event')=='sidecar-idle-stop' for e in events))
      r=req('/admin/pi/history?id='+conversation);check('cold restart retains session and history',r.status==200 and len(json.load(r)['messages'])>=2)
      check('helper was demand-started again',sum(e.get('event')=='sidecar-start' for e in proc.records())>=2)
      completed=True
      report['streaming']={'firstByteSeconds':first_at,'totalSeconds':elapsed}
    finally:
      stop.set()
      if thread:thread.join(timeout=2)
      if proc:
          report['process']=proc.close();(out/'memory-samples.json').write_text(json.dumps(proc.samples))
      if tempdir:tempdir.cleanup()
      mock.shutdown()
      report['checks']=checks;report['providerRequests']=Model.calls
      report['passed']=completed and report.get('process',{}).get('returnCode')==0 and report.get('process',{}).get('limitEnforced',False) and len(checks)>=13 and report.get('process',{}).get('memoryEvents',{}).get('oom_kill',0)==0
      (out/'acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
      print('HYBRID_SUMMARY='+json.dumps(report,ensure_ascii=False),flush=True)
    if not report['passed']:raise AssertionError('hybrid acceptance failed')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',default='rust/target/release/vtb-monitor-rs');p.add_argument('--memory-mib',type=int,default=150);main(p.parse_args())
