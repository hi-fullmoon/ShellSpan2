"""Reproducible baseline signatures/body fingerprints; no adjacent checkout reads."""
import subprocess, re, json, hashlib, pathlib
B='b2149fd97b18eb084f4dcd9fff4e7b2affa371d3'
root=pathlib.Path(__file__).resolve().parents[1]
def show(p): return subprocess.check_output(['git','show',f'{B}:{p}'],cwd=root).decode()
def split(s):
 out=[]; depth=0; start=0
 for i,c in enumerate(s):
  if c in '<([': depth+=1
  if c in '>)]': depth-=1
  if c==',' and depth==0: out.append(s[start:i].strip());start=i+1
 out.append(s[start:].strip());return [x for x in out if x]
def norm(s):return re.sub(r'\s+','',s)
lib=show('src-tauri/src/lib.rs')
handlers=re.search(r'generate_handler!\s*\[(.*?)\]',lib,re.S).group(1)
names=[x.strip().split('::')[-1] for x in handlers.split(',') if x.strip()]
contracts=json.loads((root/'electron/contract.json').read_text())
assert sorted(names)==sorted(c['command'] for c in contracts)
rows=[]
for c in contracts:
 p=c['source'].replace('native/','src-tauri/',1);src=show(p)
 match=re.search(r'fn\s+'+c['command']+r'\s*\((.*?)\)\s*(?:->\s*(.*?))?\s*\{',src,re.S)
 assert match,c['command']
 args=[]
 for a in split(match[1]):
  name,t=a.split(':',1);name=name.strip().removeprefix('mut ');t=t.strip()
  if 'State<' in t or t.split('::')[-1]=='AppHandle':continue
  name=re.sub(r'_([a-z])',lambda m:m[1].upper(),name)
  args.append({'name':name,'rustType':t,'optional':t.startswith('Option<')})
 assert [(a['name'],norm(a['rustType']),a['optional']) for a in args]==[(a['name'],norm(a['rustType']),a['optional']) for a in c['args']],c['command']
 returns=(match[2] or '()').strip();assert norm(returns)==norm(c['returns']),(c['command'],returns,c['returns'])
 current=(root/c['source']).read_text()
 if c['owner']=='native':
  wrapper=current.split('fn __ipc_'+c['command']+'(',1)[1].split('\npub(crate) async fn __ipc_',1)[0]
  actual=re.findall(r'crate::host::argument::<(.*?)>\(\s*&args,\s*\"(.*?)\",\s*\"(.*?)\"\s*,?\s*\)',wrapper,re.S)
  assert [(n,norm(t)) for t,n,command in actual]==[(a['name'],norm(a['rustType'])) for a in c['args']],c['command']
  assert all(command==c['command'] for _,_,command in actual),c['command']
  assert re.search(r'\b'+c['command']+r'\s*\(',wrapper),c['command']

 # Retain the exact function body for per-command error/cancellation review.
 depth=1;end=match.end()
 while depth:
  if src[end]=='{':depth+=1
  elif src[end]=='}':depth-=1
  end+=1
 baseline_function=src[match.start():end]
 # Fingerprint the entire source: body and referenced source definitions remain auditable.
 rows.append({**c,'baselineFunction':baseline_function,'baselineFunctionSHA256':hashlib.sha256(baseline_function.encode()).hexdigest(),'baselineSource':p,'baselineLine':src[:match.start()].count('\n')+1,'baselineSourceSHA256':hashlib.sha256(src.encode()).hexdigest(),'currentSourceSHA256':hashlib.sha256(current.encode()).hexdigest(),
 'success':'Serde serialization of '+returns,'null':'Option None -> null; unit -> null; absent/null Option args -> None',
 'error':'Result Err is serialized without stringifying structured variants; framework deserialization errors remain transport errors',
 'cancellation':'See fixed B body and cancellation registries; no synthetic cancellation or retries added'})
result={'baseline':B,'commands':rows,'validation':'Signatures compared to git object, not to generated names alone. Business execution is not certified.'}
p=(root/'electron/baseline-contract.json')
if '--check' in __import__('sys').argv:
 assert json.loads(p.read_text())==result,'Baseline trace drift; regenerate and review source changes'
else:p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(f'Compared {len(rows)} signatures and source fingerprints to {B}')
events=[
 ('ssh-data:${sessionId}','String','src-tauri/src/lib.rs','Per-session UTF-8 chunks; subscribe before mark_session_ready; unlisten detaches only this subscriber.'),
 ('ssh-status','StatusEvent','src-tauri/src/models.rs','Connecting/connected/closed states emitted by original session worker; no new ordering guarantee across sessions.'),
 ('ssh-closed','ClosedEvent','src-tauri/src/models.rs','Session identity and reason survive UI record removal; optional fields remain null.'),
 ('ssh-session-error','SessionErrorEvent','src-tauri/src/models.rs','Tagged type/payload union; field omission follows serde attributes.'),
 ('upload-progress','UploadProgressEvent','src-tauri/src/models.rs','Operation ID; original tracker throttling and final flush; cancellation does not invent a success event.'),
 ('download-progress','DownloadProgressEvent','src-tauri/src/models.rs','Operation ID; original tracker throttling and final flush.'),
 ('delete-progress','DeleteProgressEvent','src-tauri/src/models.rs','Operation ID; original precheck/approval/cancel and final flush semantics.'),
 ('remote-copy-progress','RemoteCopyProgressEvent','src-tauri/src/models.rs','Operation ID; original tracker throttling and final flush.'),
 ('agent-runtime-session-event','AgentSessionEvent','src-tauri/src/agent_runtime/event.rs','Version 5; sessionId/seq/timeUnixMs and flattened tagged payload; optional IDs omitted; replay remains get_events/get_committed_events.'),
 ('port-forward-event','PortForwardRuntime','src-tauri/src/port_forward.rs','Operation/profile/config IDs and runtime status/counters; no synthetic retry.'),
 ('petdex-status','PetdexConnectionStatus','src-tauri/src/petdex/types.rs','CamelCase enum: notDetected/connected/notRunning/connectionError.'),
 *[(n,'()','src-tauri/src/menu.rs','Unit -> null; native menu/close callback; subscribe at App mount and detach on cleanup.') for n in ['system-open-settings','system-about','system-check-update','system-request-app-exit']]
]
ev=[]
for name,typ,path,behavior in events:
 src=show(path);definition=None
 if typ not in ('String','()'):
  m=re.search(r'(?:pub(?:\(crate\))?\s+)?(?:struct|enum)\s+'+typ+r'\s*\{',src);assert m,typ
  depth=1;i=m.end()
  while depth:
   if src[i]=='{':depth+=1
   elif src[i]=='}':depth-=1
   i+=1
  # Include serde attributes immediately preceding the definition.
  start=src.rfind('#[derive',0,m.start())
  definition=src[start:i]
 ev.append({'name':name,'rustPayload':typ,'baselineSource':path,'sourceSHA256':hashlib.sha256(src.encode()).hexdigest(),'definition':definition,'behavior':behavior})
callbacks=[
 {'name':'desktop-resized','visibility':'renderer','payload':'null','baseline':'Window.onResized PhysicalSize','adaptation':'Current UI callbacks requery isMaximized; physical size is not consumed; coalescing/real window behavior stage2.'},
 {'name':'desktop-drag-drop','visibility':'renderer-local','payload':'DragDropEvent in src/lib/desktop/window.ts','baseline':'WebviewWindow.onDragDropEvent','adaptation':'DOM clientX/Y and macOS Wry coordinates are logical pixels; drop resolves webUtils paths. Phase3 verified native right-directory and left-multiple drops; Windows remains unverified.'},
 {'name':'desktop-update-progress','visibility':'renderer','payload':'Started {contentLength?} | Progress {chunkLength} | Finished','baseline':'updater DownloadEvent','adaptation':'Subscribe before download; finally unsubscribe; original API exposes no cancel action. Phase2 verified Started/Finished for cached and zero-progress local downloads; real installation is a stage4 condition.'},
 {'name':'desktop-exit','visibility':'main-only','payload':'i32 exit code','baseline':'AppHandle.exit(code)','adaptation':'Main stops core then quits; currently ignores code (existing request_app_exit uses 0).'},
 {'name':'desktop-restart','visibility':'main-only','payload':'null','baseline':'AppHandle.request_restart','adaptation':'Main stops core then relaunches, or installs already downloaded update.'}
]
result={'baseline':B,'businessEvents':ev,'callbacks':callbacks,'privateTransport':{'control':'length-prefixed JSON on stdin/stdout; existing request/response/validate envelopes','terminal':'separate private Unix socket or Windows named pipe; length-prefixed JSON event plus strictly increasing terminalSeq','ready':'protocol 1 plus required terminalChannel:true; resolve only after terminal connection exists','diagnostics':'stderr only; bounded nonblocking log queue with explicit omission summary','rendererCredits':['desktop:terminal-ack','desktop:terminal-ready'],'rendererCreditSecurity':'verified current main frame; no raw IPC exported; old credit IDs ignored after trusted main-frame reload'},'privateRequests':[{'type':'validate','commands':['pick_local_files','pick_local_folder','pick_private_key_file','export_log_file'],'result':'null on valid arguments; baseline Serde error otherwise','purpose':'Main validates dialog arguments in native without executing dialogs or business commands; not exposed in preload'}],'dynamicId':'Core creates UUID v4; whitelist preserves baseline allowed event characters rather than requiring UUID on subscription. No cross-session authorization boundary inside the single trusted renderer.','unlisten':'Idempotent, removes exact callback; snapshots dispatch in subscription order; no raw Electron event object exposed.'}
p=root/'electron/event-contract.json'
if '--check' in __import__('sys').argv:assert json.loads(p.read_text())==result,'Event trace drift'
else:p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('Traced 15 business events and 5 callback/internal contracts')
# Preserve actual Serde attributes/field types transitively instead of inventing
# a second, lossy JS schema for flatten/tag/default/custom Deserialize behavior.
paths=subprocess.check_output(['git','ls-tree','-r','--name-only',B,'src-tauri/src'],cwd=root).decode().splitlines()
index={}
for path in paths:
 if not path.endswith('.rs'):continue
 src=show(path)
 for m in re.finditer(r'pub(?:\([^)]*\))?\s+(?:struct|enum|type)\s+(\w+)',src):
  name=m[1];start=src.rfind('\n\n',0,m.start())+2
  # Entire source blob is the authority, including custom serializer functions.
  index.setdefault(name,[]).append({'source':path,'line':src[:m.start()].count('\n')+1,'sourceSHA256':hashlib.sha256(src.encode()).hexdigest()})
types=sorted(set(token for c in contracts for t in [c['returns'],*[a['rustType'] for a in c['args']]] for token in re.findall(r'\b[A-Z]\w*',t) if token not in {'Result','Option','String','Vec'}))
def declaration(src, name):
 m=re.search(r'pub(?:\([^)]*\))?\s+(?:struct|enum|type)\s+'+name+r'\b',src)
 assert m,name
 start=src.rfind('\n\n',0,m.start())+2
 brace=src.find('{',m.end());semi=src.find(';',m.end())
 if semi>=0 and (brace<0 or semi<brace):return src[start:semi+1]
 depth=1;i=brace+1
 while depth:
  if src[i]=='{':depth+=1
  elif src[i]=='}':depth-=1
  i+=1
 return src[start:i]
for name in types:
 for item in index.get(name,[]):
  baseline=show(item['source']);current=(root/item['source'].replace('src-tauri/','native/',1)).read_text()
  before=declaration(baseline,name);after=declaration(current,name)
  assert before==after,('Argument/result definition differs from B',name,item['source'])
  item['definition']=before
result={'baseline':B,'rootTypes':{t:index.get(t,[]) for t in types},'rule':'Resolve Rust paths in command source modules. Definitions and custom Serde are bound by source hash; JS does not replace native Deserialize. Ambiguous short names retain every source candidate.'}
assert all(result['rootTypes'].values()),[t for t,v in result['rootTypes'].items() if not v]
p=root/'electron/type-contract.json'
if '--check' in __import__('sys').argv:assert json.loads(p.read_text())==result,'Type definition trace drift'
else:p.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(f'Traced {len(types)} named argument/result types to fixed-B definitions')
