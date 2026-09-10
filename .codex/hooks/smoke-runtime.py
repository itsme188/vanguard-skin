#!/usr/bin/env python3
"""Exercise Codex Stop with a loopback Responses fixture and disposable trusted config.
Run: python3 .codex/hooks/smoke-runtime.py (requires installed codex, no remote AI).
Artifacts are printed and retained in /private/tmp for review. No production config changes.
"""
import json,os,pathlib,subprocess,tempfile,threading,http.server
root=pathlib.Path(tempfile.mkdtemp(prefix='portfolio-hook-runtime-',dir='/private/tmp'))
home=root/'codex-home'; home.mkdir(); fixture=root/'renamed-checkout'; fixture.mkdir()
subprocess.run(['git','init','-q',str(fixture)],check=True)
(fixture/'package.json').write_text(json.dumps({'name':'vanguard-skin','repository':{'url':'https://github.com/itsme188/vanguard-skin.git'}}))
(fixture/'scripts').mkdir(); (fixture/'scripts/verify.sh').write_text('#!/bin/bash\necho synthetic-verification-failure >&2\nexit 7\n')
requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*a): pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('content-length','0')));requests.append(json.loads(body))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  msg={'id':'msg_fixture','type':'message','status':'completed','role':'assistant','content':[{'type':'output_text','text':'Synthetic hook probe complete.','annotations':[]}]}
  events=[{'type':'response.created','response':{'id':'resp_fixture','status':'in_progress','output':[]}}, {'type':'response.output_item.added','output_index':0,'item':msg},{'type':'response.output_text.delta','item_id':'msg_fixture','output_index':0,'content_index':0,'delta':'Synthetic hook probe complete.'},{'type':'response.output_item.done','output_index':0,'item':msg},{'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':[msg],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}}]
  for event in events:self.wfile.write(('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n').encode())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
hook=str(pathlib.Path(__file__).resolve().with_name('stop-vitest.sh'))
config=f'''model = "gpt-5.5"
model_provider = "fixture"
[model_providers.fixture]
name = "Local deterministic verification fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
[features]
hooks = true
[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "bash {hook}"
timeout = 15
'''
(home/'config.toml').write_text(config)
env={**os.environ,'CODEX_HOME':str(home)}
p=subprocess.Popen(['codex','app-server','--stdio'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(root/'list.stderr','w'),text=True)
def send(o):p.stdin.write(json.dumps(o)+'\n');p.stdin.flush()
send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'fixture','version':'1'},'capabilities':{'experimentalApi':True}}})
for line in p.stdout:
 if json.loads(line).get('id')==1:break
send({'method':'initialized'});send({'id':2,'method':'hooks/list','params':{'cwds':[str(fixture)]}})
for line in p.stdout:
 o=json.loads(line)
 if o.get('id')==2:
  (root/'registration.json').write_text(json.dumps(o,indent=2));meta=o['result']['data'][0]['hooks'][0];break
p.terminate();p.wait()
# Trust ONLY the reviewed synthetic fixture registration in its disposable home.
with (home/'config.toml').open('a') as f:f.write('\n[hooks.state.'+json.dumps(meta['key'])+']\ntrusted_hash = '+json.dumps(meta['currentHash'])+'\n')
result=subprocess.run(['codex','exec','--json','--skip-git-repo-check','--sandbox','read-only','-C',str(fixture),'Return the synthetic fixture message without calling tools.'],env=env,capture_output=True,text=True,timeout=45)
(root/'events.jsonl').write_text(result.stdout);(root/'stderr.log').write_text(result.stderr)
(root/'requests.json').write_text(json.dumps(requests,indent=2))
assert result.returncode == 0, result.stderr
assert len(requests) == 2, f'Expected one Stop continuation, got {len(requests)} requests'
assert 'synthetic-verification-failure' in json.dumps(requests[1]['input']), 'Hook failure was not delivered to model'
print(json.dumps({'root':str(root),'exit':result.returncode,'requests':len(requests),'stdout':result.stdout[-9000:],'stderr':result.stderr[-4000:]}))
server.shutdown()
