#!/usr/bin/env python3
"""Verify measured closure properties without upgrading failed model outcomes."""
import base64,hashlib,json,sys
from pathlib import Path
from byte_accounting import account

def stable(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def jsonl(file):return [json.loads(x) for x in file.read_text().splitlines() if x.startswith('{')]
def tool_outputs(file,name):
 return [json.loads(r['part']['state']['output']) for r in jsonl(file) if r.get('type')=='tool_use' and r['part']['tool']==name and r['part']['state'].get('output')]
def verify(root):
 root=Path(root);after=root/'after';checks={}
 for label,base in [('before',root/'before/live-store'),('after',after/'live-store')]:
  events=0;blobs=0
  for ws in (base/'workspaces').iterdir():
   for p in (ws/'events').glob('*.json'):
    e=json.loads(p.read_text());body={k:v for k,v in e.items() if k not in ['at','ref']}
    assert e['ref']=='evt_'+hashlib.sha256(stable(body)).hexdigest()
    assert e['workspaceID']==ws.name
    digest=e['payload']['sha256'];data=(ws/'blobs'/digest[:2]/digest).read_bytes()
    assert hashlib.sha256(data).hexdigest()==digest and len(data)==e['payload']['bytes'];events+=1
   for p in (ws/'blobs').glob('*/*'):
    assert hashlib.sha256(p.read_bytes()).hexdigest()==p.name;blobs+=1
  checks[label+'_integrity']={'events':events,'blobs':blobs}
 storage=next((after/'storage/growing_context_1k/store/workspaces').iterdir());acct=account(storage)
 assert acct['subsets_not_additive']['cumulative_ID_array_bytes']==0
 assert acct['events_by_type']['message.persisted']==2000
 checkpoints=[]
 for p in (storage/'events').glob('*.json'):
  e=json.loads(p.read_text())
  if e['type']=='context.checkpoint':
   digest=e['payload']['sha256'];v=json.loads((storage/'blobs'/digest[:2]/digest).read_text());assert len(v['messageIDsTail'])<=8;checkpoints.append(v)
 assert len(checkpoints)==1000 and max(v['messageCount'] for v in checkpoints)==2000
 checks['checkpoint_growth']={'checkpoints':1000,'exact_message_events':2000,'max_tail':8,'allocated_file_bytes':acct['allocated_file_bytes']}
 for label in ['before','after']:
  v=json.loads((root/label/'coordination/coordination-results.json').read_text());assert v['peer_exact_recovery'] and v['foreign_workspace_rejected'];assert all(x['peers_with_current_advisory']==4 for x in v['simultaneous_intent_rounds'])
 checks['coordination_before_after']=True
 for side in ['off','on']:
  raw=jsonl(after/f'closure-failure-{side}.jsonl');tools=[r['part'] for r in raw if r.get('type')=='tool_use']
  assert all(any(t['tool']==name and t['state']['status']=='completed' for t in tools) for name in ['read','write','edit','shell'])
  if side=='on':assert tool_outputs(after/f'closure-failure-{side}.jsonl','trace_status')[0]['ok'] is False
 failures=json.loads((after/'closure-failure-results.json').read_text());assert all(x['file'].strip()=='STORE_FAILURE_NATIVE_OK' and x['stage']['exit']==0 for x in failures)
 checks['native_failure_injection']='Both OFF and ON completed native read/write/edit/shell; ON trace status ENOTDIR.'
 complete=tool_outputs(after/'closure-lifecycle-observe-completion.jsonl','trace_status')[0]
 deleted=tool_outputs(after/'closure-lifecycle-observe-deletion.jsonl','trace_status')[0]
 owner=json.loads((after/'closure-lifecycle-host-deletion.json').read_text())['deleted_owned_fixture_session']
 a=next(p for p in complete['peers'] if p['sessionID']==owner);b=next(p for p in deleted['peers'] if p['sessionID']==owner)
 assert a['intent']['status']==b['intent']['status']=='active'
 assert a['observation']['host_deleted_evidence'] is None and a['observation']['liveness_unknown']
 assert b['observation']['host_deleted_evidence'] and not b['observation']['liveness_unknown']
 checks['declared_intent_unchanged_with_real_host_deletion']=True
 glm=json.loads((after/'glm-postcompact-results.json').read_text());assert {x['side'] for x in glm}=={'on','off'}
 for x in glm:assert x['codes_in_compacted_context']==0 and x['exit']==0
 checks['glm_postcompact']=[{k:x[k] for k in ['side','correct','total','codes_in_compacted_context']} for x in glm]
 outcome=json.loads((root/'recovery-1-outcomes.json').read_text())['outcomes']
 checks['qwen_before_outcomes']=[{k:x[k] for k in ['side','mode','correct','total','exit']} for x in outcome]
 checks['qwen_after']=json.loads((after/'qwen-after-classification.json').read_text())
 checks['meaning']='Verified listed substrate/native/storage properties. Qwen post-fix model retrieval is unresolved; not an overall model PASS.'
 (after/'closure-verification.json').write_text(json.dumps(checks,indent=2));return checks
if __name__=='__main__':print(json.dumps(verify(sys.argv[1]),indent=2))
