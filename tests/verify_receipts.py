#!/usr/bin/env python3
"""Verify durable real-host receipts; never trusts a model's final PASS claims."""
import argparse
import hashlib
import json
from pathlib import Path


def verify(root):
    checks = {}
    def passed(name, details=True):
        checks[name] = {'status': 'PASS', 'details': details}
    def calls(name):
        rows = [json.loads(line) for line in (root / (name + '.jsonl')).read_text().splitlines() if line.startswith('{')]
        assert not any(r.get('type') == 'error' for r in rows), name
        return [r['part'] for r in rows if r.get('type') == 'tool_use']
    def output(call):
        return call['state'].get('output', '')
    baseline = calls('baseline-native')
    final = calls('qualified-final')
    for tool in ['read', 'shell', 'write', 'edit', 'subagent', 'execute']:
        for label, rows in [('baseline', baseline), ('installed', final)]:
            selected = [c for c in rows if c['tool'] == tool]
            assert selected and all(c['state']['status'] == 'completed' for c in selected), (label, tool)
        passed('native_' + tool)
    assert any('Node.js' in output(c) for c in final if c['tool'] == 'execute')
    passed('third_party_context7')
    for name in ['scripted-baseline', 'scripted-installed-final']:
        c = next(c for c in calls(name) if c['tool'] == 'patch')
        assert c['state']['status'] == 'completed' and 'M patch.txt' in output(c)
    passed('native_patch', 'Real native patch via deterministic local model fixture; GLM/Qwen use native edit/write')
    wires = [json.loads(l) for l in (root / 'fixture-wire.jsonl').read_text().splitlines()]
    base = next(set(w['tool_names']) for w in wires if w['case'] == 'patch_baseline' and w['tool_names'])
    current = next(set(w['tool_names']) for w in reversed(wires) if w['case'] == 'patch_installed' and w['tool_names'])
    assert current - base == {'trace_note', 'trace_expand', 'trace_intent', 'trace_status'} and base <= current
    passed('native_catalog_preserved', sorted(base))
    events = [json.loads(p.read_text()) for p in (root / 'qualified-store').glob('workspaces/*/events/evt_*.json')]
    # Group full host identity too: older retained extraction receipts predate
    # the dispatcher-aware callKey fix. They remain immutable and retrievable.
    before = {(e['callKey'], e['tool']): e for e in events if e['type'] == 'tool.before'}
    after = {(e['callKey'], e['tool']): e for e in events if e['type'] == 'tool.after'}
    assert before.keys() == after.keys(), (len(before), len(after))
    for key, e in after.items():
        assert e['callID'] and all(e['host'].get(k) for k in ['sessionID', 'messageID', 'agent'])
        assert before[key]['tool'] == e['tool']
        assert e['payload']['sha256'] and e['payload']['bytes'] > 0
    passed('paired_history', {'calls': len(before), 'tools': sorted({e['tool'] for e in after.values()})})
    expands = [json.loads(output(c)) for c in final if c['tool'] == 'trace_expand']
    assert expands and all(x['ok'] and 'TRACE_ORIGINAL_DOCUMENT_94317' in x['exact_utf8'] for x in expands)
    assert 'TRACE_CHANGED_DOCUMENT_94317' in (root / 'qualified/document.txt').read_text()
    passed('exact_provenance_after_file_change')
    sessions = {e['host']['sessionID'] for e in events if e['host'].get('sessionID')}
    assert len(sessions) >= 3
    statuses = [json.loads(output(c)) for c in final if c['tool'] == 'trace_status']
    assert all(s['ok'] and s['errors'] == 0 for s in statuses)
    assert any(s['peers'] for s in statuses)
    passed('multi_session_peers', len(sessions))
    advisories = [e for e in events if e['type'] == 'coordination.advisory']
    assert advisories and all(len(e['peers']) == 2 for e in advisories)
    assert any(e['paths'] and e['tool'] == 'edit' for e in before.values())
    passed('intent_and_structured_mutation_advisories', len(advisories))
    assert all(e['paths'] == 'unknown' for e in before.values() if e['tool'] == 'shell')
    passed('unknown_shell_paths')
    compact = [e for e in events if e['type'] == 'compaction']
    assert compact and any(e['compact']['refs'] and e['compact']['recovery_gap'] is None for e in compact)
    passed('glm_native_compact_valid_map')
    malformed_sid = (root / 'malformed-final-sid').read_text()
    scripted = [json.loads(p.read_text()) for p in (root / 'scripted-store').glob('workspaces/*/events/evt_*.json')]
    broken = [e for e in scripted if e['type'] == 'compaction' and e['host'].get('sessionID') == malformed_sid]
    assert broken and all(e['compact']['recovery_gap'] == 'invalid_json' for e in broken)
    for e in broken:
        blob = next((root / 'scripted-store').glob(f'workspaces/*/blobs/{e["payload"]["sha256"][:2]}/{e["payload"]["sha256"]}'))
        assert json.loads(blob.read_text())['status'] == 'completed'
    passed('malformed_map_native_compact_completes')
    for c in calls('store-failure-final'):
        assert c['state']['status'] == 'completed'
        if c['tool'] == 'trace_status': assert json.loads(output(c))['ok'] is False
    passed('store_failure_native_tools_continue')
    restart = json.loads((root / 'restart-state.json').read_text())
    assert restart['status'] == 'PASS' and restart['beforePID'] != restart['afterPID']
    recover = calls('restart-recover')
    state = json.loads(output(next(c for c in recover if c['tool'] == 'trace_status')))
    assert state['notes'] and restart['sourceRef'] in state['compact']['refs']
    expanded = json.loads(output(next(c for c in recover if c['tool'] == 'trace_expand')))
    assert 'PATCH_BEFORE_94317' in expanded['exact_utf8']
    recovery_wires = [w for w in wires if w['case'] in ['restart_recover', 'restart_release']]
    assert any(state['compact']['ref'] in str(w['recalls']) for w in recovery_wires)
    passed('process_restart_and_compact_source_recovery', restart)
    recall_sizes = [e['recallBytes'] for e in events if e['type'] == 'context.checkpoint']
    assert recall_sizes and max(recall_sizes) <= 12288
    passed('recall_hard_ceiling', {'max_bytes': max(recall_sizes), 'checkpoints': len(recall_sizes)})
    qwen = calls('qwen-reprobe')
    assert any(c['tool'] == 'shell' and output(c) == 'QWEN27B_TRACE_NATIVE_OK' for c in qwen)
    assert all(c['state']['status'] == 'completed' for c in qwen)
    passed('qwen_27b_native_trace_smoke')
    qwen_final = calls('qwen-final')
    expected = {'read', 'shell', 'write', 'edit', 'execute', 'subagent', 'trace_status', 'trace_note', 'trace_intent', 'trace_expand'}
    assert expected <= {c['tool'] for c in qwen_final}
    assert all(c['state']['status'] == 'completed' for c in qwen_final)
    passed('qwen_27b_complete_release_toolchain')
    rollback = json.loads((root / 'isolated-rollback-final.json').read_text())
    assert rollback['exact'] and rollback['historyPreserved']
    assert 'opencode-trace' not in (root / 'rollback-plugins.txt').read_text()
    assert all(c['state']['status'] == 'completed' for c in calls('rollback-native'))
    passed('actual_host_rollback_and_native_smoke')
    # Verify every referenced payload and standalone immutable event body.
    count = 0
    for folder in ['qualified-store', 'scripted-store']:
        for p in (root / folder).glob('workspaces/*/events/evt_*.json'):
            e = json.loads(p.read_text()); ref = e.pop('ref'); e.pop('at')
            digest = hashlib.sha256(json.dumps(e, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            assert ref == 'evt_' + digest
            descriptor = e['payload']; blob = p.parent.parent / 'blobs' / descriptor['sha256'][:2] / descriptor['sha256']
            data = blob.read_bytes(); assert hashlib.sha256(data).hexdigest() == descriptor['sha256'] and len(data) == descriptor['bytes']
            count += 1
    passed('durable_event_and_blob_integrity', count)
    return {'status': 'PASS', 'checks': checks}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('receipts', type=Path)
    args = parser.parse_args()
    result = verify(args.receipts)
    (args.receipts / 'qualification.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
