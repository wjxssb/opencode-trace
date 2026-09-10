import json, sys
from pathlib import Path

def account(root):
 root=Path(root); cats={}; events=[]; payloads=set(); texts=set(); cp=set(); compact=set(); idbytes=0; checkpointmeta=0
 def add(cat,p):
  s=p.stat(); d=cats.setdefault(cat,{'objects':0,'bytes':0,'allocated_file_bytes':0});d['objects']+=1;d['bytes']+=s.st_size;d['allocated_file_bytes']+=s.st_blocks*512
 for p in (root/'events').glob('*.json'):
  e=json.loads(p.read_text());events.append(e);add('event_envelopes',p);payloads.add(e['payload']['ref'][5:]);texts.update(x['ref'][5:] for x in e.get('outputs',[]))
  if e['type']=='context.checkpoint':cp.add(e['payload']['ref'][5:])
  if e['type']=='compaction':compact.add(e['payload']['ref'][5:])
 for p in (root/'blobs').glob('*/*'):
  cat='payload_and_text_shared' if p.name in payloads & texts else 'event_payload_blobs' if p.name in payloads else 'extracted_text_blobs' if p.name in texts else 'unreferenced_blobs'
  add(cat,p)
  if p.name in cp:
   v=json.loads(p.read_text()); ids=v.get('messageIDs'); idbytes+=len(json.dumps(ids,separators=(',',':'),ensure_ascii=False).encode()) if ids is not None else 0
   checkpointmeta+=len(json.dumps({k:v[k] for k in ['messageCount','messageIDsSha256','messageIDsTail'] if k in v},separators=(',',':'),ensure_ascii=False).encode()) if ids is None else 0
 for d in ['sessions','recall','intents','state']:
  for p in (root/d).glob('*'):
   if p.is_file():add(d+'_snapshots',p)
 blobs=lambda refs:sum((root/'blobs'/r[:2]/r).stat().st_size for r in refs)
 return {'root':str(root),'exclusive_categories':cats,'total_bytes':sum(v['bytes'] for v in cats.values()),'allocated_file_bytes':sum(v['allocated_file_bytes'] for v in cats.values()),'subsets_not_additive':{'checkpoint_payload_bytes':blobs(cp),'cumulative_ID_array_bytes':idbytes,'bounded_checkpoint_metadata_bytes':checkpointmeta,'compaction_payload_bytes':blobs(compact)},'events_by_type':{t:sum(e['type']==t for e in events) for t in sorted({e['type'] for e in events})}}
if __name__=='__main__':
 base=Path(sys.argv[1]); out={}
 for p in base.glob('*/store/workspaces/*'):out[p.parents[2].name]=account(p)
 Path(sys.argv[2]).write_text(json.dumps(out,indent=2)); print(json.dumps(out.get('growing_context_1k',out),indent=2))
