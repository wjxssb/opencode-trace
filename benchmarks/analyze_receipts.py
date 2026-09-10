#!/usr/bin/env python3
"""Mechanical audit of synthetic test receipts; never performs runtime retrieval."""
import base64,json,sys
from pathlib import Path

def rows(file):
 if not file.exists():return []
 result=[]
 for line in file.read_text().splitlines():
  try:result.append(json.loads(line))
  except ValueError:pass
 return result

def analyze(root):
 root=Path(root);stages=rows(root/'live-stages.jsonl');events=[]
 for f in (root/'live-store').glob('workspaces/*/events/*.json'):
  e=json.loads(f.read_text());e['_workspace_root']=str(f.parent.parent);events.append(e)
 wires=[json.loads(f.read_text()) for f in (root/'wire').glob('*.summary.json')]
 if (root/'glm-existing-history-result.json').exists():
  s=json.loads((root/'glm-existing-history-result.json').read_text());s['sessionID']=s['sessionIDs'][0];stages.append(s)
 results=[]
 for s in stages:
  raw=rows(root/(s['name']+'.jsonl'));calls=[r['part'] for r in raw if r.get('type')=='tool_use'];pages=[];seen=set();coverage={}
  for c in calls:
   if c['tool']!='trace_expand':continue
   state=c['state'];i=state.get('input',{});out=state.get('output','{}')
   try:o=json.loads(out) if isinstance(out,str) else out
   except ValueError:o={}
   lim=i.get('limit',2048 if o.get('hash_verified') else 12000);off=i.get('offset',0);key=(i.get('ref'),off,lim)
   payload=o.get('payload_ref') or o.get('metadata',{}).get('payload',{}).get('ref') or i.get('ref')
   data=base64.b64decode(o.get('exact_base64',''));covered=coverage.setdefault(payload,set());interval=set(range(off,off+len(data)));repeated=len(interval & covered);covered.update(interval)
   page={'ref':i.get('ref'),'offset':off,'limit':lim,'metadata_only':i.get('metadata_only',False),'total_bytes':o.get('total_bytes'),'next_offset':o.get('next_offset'),'related_refs':o.get('related_refs',[]),'source_bytes_returned':len(data),'whole_output_bytes':len(out.encode()) if isinstance(out,str) else len(json.dumps(out).encode()),'exact_tuple_already_requested':key in seen,'payload_ref':payload,'source_bytes_already_returned':repeated,'status':state.get('status')};pages.append(page);seen.add(key)
  requests=sorted([w for w in wires if s['started']<=w['started']<=s['ended']],key=lambda w:w['started']) if not s['name'].startswith(('glm-', 'closure-')) else []
  usages=[w['usage'] for w in requests if w.get('usage')]
  compact=[]
  for e in events:
   if e['type']=='compaction' and e['host'].get('sessionID')==s.get('sessionID') and s['started']*1000<=e['at']<=s['ended']*1000:
    compact.append(e['host']['messageID'])
  tokens={'source':'qwen_proxy_usage','input':sum(u['prompt_tokens'] for u in usages),'output':sum(u['completion_tokens'] for u in usages),'requests':len(requests),'missing_usage':len(requests)-len(usages),'peak_input':max([u['prompt_tokens'] for u in usages],default=None)}
  if not requests:
   finishes=[r['part'].get('tokens',{}) for r in raw if r.get('type')=='step_finish'];tokens={'source':'native_step_finish','input':sum(x.get('input',0) for x in finishes),'output':sum(x.get('output',0) for x in finishes),'reasoning':sum(x.get('reasoning',0) for x in finishes),'cache_read':sum(x.get('cache',{}).get('read',0) for x in finishes),'step_finishes':len(finishes)}
  result={'name':s['name'],'sessionID':s.get('sessionID'),'exit':s['exit'],'wall_seconds':s['elapsed_seconds'],'trace_calls':sum(c['tool'].startswith('trace_') for c in calls),'native_calls':sum(not c['tool'].startswith('trace_') for c in calls),'expansion_calls':len(pages),'exact_duplicate_pages':sum(p['exact_tuple_already_requested'] for p in pages),'repeated_payload_bytes':sum(p['source_bytes_already_returned'] for p in pages),'tokens':tokens,'completed_compaction_archives_during_turn':len(set(compact)),'pages':pages}
  export_file=root/'native-exports'/f"{s.get('sessionID')}.json"
  if export_file.exists():
   exported=json.loads(export_file.read_text());exported=exported.get('data',exported)
   result['native_compactions_during_turn']=[{'id':m['id'],'status':m.get('status')} for m in exported['messages'] if m.get('type')=='compaction' and s['started']*1000<=m.get('time',{}).get('created',0)<=s['ended']*1000]
   result['model']=exported['info'].get('model')
   if tokens['source']=='native_step_finish':
    messages=[m for m in exported['messages'] if m.get('type')=='assistant' and s['started']*1000<=m.get('time',{}).get('created',0)<=s['ended']*1000]
    usage=[m['tokens'] for m in messages if m.get('tokens')]
    result['tokens']={'source':'native_export_assistant_usage','input':sum(x.get('input',0) for x in usage),'output':sum(x.get('output',0) for x in usage),'reasoning':sum(x.get('reasoning',0) for x in usage),'cache_read':sum(x.get('cache',{}).get('read',0) for x in usage),'requests':len(messages),'missing_usage':len(messages)-len(usage)}
  result['storage_delta']=s.get('storage_delta')
  if result['tokens']['source']=='native_step_finish':
   archived={}
   for e in events:
    if e['type']!='message.persisted' or e['host'].get('sessionID')!=s.get('sessionID'):continue
    digest=e['payload']['sha256'];m=json.loads((Path(e['_workspace_root'])/'blobs'/digest[:2]/digest).read_text())
    if m.get('type')=='assistant' and s['started']*1000<=m.get('time',{}).get('created',0)<=s['ended']*1000:archived[m['id']]=m
   if archived:
    usage=[m['tokens'] for m in archived.values() if m.get('tokens')]
    result['tokens']={'source':'trace_archived_native_assistant_usage','input':sum(x.get('input',0) for x in usage),'output':sum(x.get('output',0) for x in usage),'reasoning':sum(x.get('reasoning',0) for x in usage),'cache_read':sum(x.get('cache',{}).get('read',0) for x in usage),'requests':len(archived),'missing_usage':len(archived)-len(usage)}
  results.append(result)
 out={'method':'Actual CLI tool receipts and request usage; completed compaction archives are observed completions, not attempted or failed native compactions. Source byte overlap resolves event payload aliases. Storage snapshot deltas are in per-turn receipts when measured.','stages':results}
 (root/'mechanical-analysis.json').write_text(json.dumps(out,indent=2));return out
if __name__=='__main__':
 out=analyze(sys.argv[1]);print(json.dumps([{k:v for k,v in s.items() if k!='pages'} for s in out['stages']],indent=2))
