#!/usr/bin/env python3
"""Check private real-host receipts against actual files, refs, hashes and wire data."""
import argparse
import hashlib
import json
from pathlib import Path


def answer(text, expected):
    value = {}
    for offset, char in enumerate(text):
        if char == '{':
            try:
                candidate, _ = json.JSONDecoder().raw_decode(text[offset:])
                if isinstance(candidate, dict) and set(expected) <= set(candidate):
                    value = candidate
            except ValueError:
                pass
    return {key: value.get(key) for key in expected}


def verify(root):
    root = Path(root)
    paths = json.loads((root / 'paths.json').read_text())
    work = Path(paths['work'])
    stages = [json.loads(line) for line in (root / 'live-stages.jsonl').read_text().splitlines()]
    wires = [json.loads(p.read_text()) for p in sorted((root / 'wire').glob('*.summary.json'))]
    events = {}
    blob_count = 0
    for f in (root / 'live-store').glob('workspaces/*/events/*.json'):
        event = json.loads(f.read_text())
        body = {k: v for k, v in event.items() if k not in ['at', 'ref']}
        encoded = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
        assert event['ref'] == 'evt_' + hashlib.sha256(encoded).hexdigest(), f.name
        digest = event['payload']['sha256']
        data = (f.parent.parent / 'blobs' / digest[:2] / digest).read_bytes()
        assert hashlib.sha256(data).hexdigest() == digest
        assert len(data) == event['payload']['bytes']
        events[event['ref']] = event
        blob_count += 1
    def calls(name):
        rows = [json.loads(line) for line in (root / (name + '.jsonl')).read_text().splitlines() if line.startswith('{')]
        return [r['part'] for r in rows if r.get('type') == 'tool_use']
    def output(call):
        return json.loads(call['state']['output'])
    def stage_wires(stage):
        return [w for w in wires if stage['started'] <= w['started'] <= stage['ended']]
    expected = json.loads((root / 'recovery-1-expected.json').read_text())['expected']
    outcomes = []
    for stage in stages:
        if 'new_peer' not in stage['name'] and 'same_session_after_compact' not in stage['name']:
            continue
        response = answer('\n'.join(stage['texts']), expected)
        selected = stage_wires(stage)
        first = json.loads((root / 'wire' / (selected[0]['id'] + '.request.json')).read_text())
        original_codes_in_initial_request = sum(v in json.dumps(first['messages']) for v in expected.values())
        assert original_codes_in_initial_request == 0, stage['name']
        outcomes.append({'name': stage['name'], 'correct': sum(response[k] == v for k, v in expected.items()),
                         'total': len(expected), 'exit': stage['exit'], 'elapsed_seconds': stage['elapsed_seconds'],
                         'initial_request_original_codes': original_codes_in_initial_request,
                         'model_requests': len(selected),
                         'input_tokens_sum': sum((w['usage'] or {}).get('prompt_tokens', 0) for w in selected),
                         'output_tokens_sum': sum((w['usage'] or {}).get('completion_tokens', 0) for w in selected)})
    seeds = json.loads((root / 'recovery-1-outcomes.json').read_text())['seeds']
    peer_calls = calls('recovery-1-on-new_peer')
    expanded = [output(c) for c in peer_calls if c['tool'] == 'trace_expand']
    sources = [x for x in expanded if x.get('metadata', {}).get('tool') == 'read'
               and x.get('metadata', {}).get('host', {}).get('sessionID') == seeds['on']
               and all(value in x.get('exact_utf8', '') for value in expected.values())]
    assert sources, 'Peer did not recover the original reader event'
    source_ref = sources[0]['ref']
    notes = [e for e in events.values() if e['type'] == 'trace.note' and e['host'].get('sessionID') == seeds['on'] and source_ref in e['note']['source_refs']]
    assert notes
    peer_stage = next(s for s in stages if s['name'] == 'recovery-1-on-new_peer')
    first_peer_wire = stage_wires(peer_stage)[0]
    peer_refs = [ref for rec in first_peer_wire['recalls'] for p in (rec['view'] or {}).get('peers', []) for ref in p.get('note_refs', [])]
    assert notes[0]['ref'] in peer_refs, 'Seed note was not visible at the real model request boundary'
    for side in ['on', 'off']:
        assert all(value not in (work / side / 'ledger.txt').read_text() for value in expected.values())
        assert all(value not in (root / f'recovery-1-{side}-compact-context.json').read_text() for value in expected.values())
    probes = []
    for stage in stages:
        if not stage['name'].startswith('probe-'):
            continue
        selected = stage_wires(stage)
        actual = calls(stage['name'])
        assert len(actual) == 1 and actual[0]['tool'] == 'shell' and actual[0]['state']['status'] == 'completed'
        assert actual[0]['state']['output'].startswith('TRACE_NATIVE_PROBE_')
        probes.append({'name': stage['name'], 'side': stage['side'], 'elapsed_seconds': stage['elapsed_seconds'],
                       'model_requests': len(selected),
                       'input_tokens_sum': sum((w['usage'] or {}).get('prompt_tokens', 0) for w in selected),
                       'output_tokens_sum': sum((w['usage'] or {}).get('completion_tokens', 0) for w in selected),
                       'initial_input_tokens': (selected[0]['usage'] or {}).get('prompt_tokens'),
                       'initial_tool_schema_bytes': selected[0]['tool_schema_bytes'],
                       'initial_recall_bytes': sum(x['bytes'] for x in selected[0]['recalls'])})
    compactions = [e for e in events.values() if e['type'] == 'compaction']
    result = {'receipt_checks_passed': True, 'runtime_events_hash_checked': len(events), 'payload_hash_checks': blob_count,
              'recovery': outcomes, 'peer_chain': {'source_ref': source_ref, 'note_ref': notes[0]['ref'], 'first_model_request_has_peer_note_ref': True},
              'probes': probes,
              'context': {'checkpoints': sum(e['type'] == 'context.checkpoint' for e in events.values()),
                          'max_recall_bytes': max(e.get('recallBytes', 0) for e in events.values()),
                          'compactions': len(compactions),
                          'valid_maps': sum(e['compact']['recovery_gap'] is None for e in compactions),
                          'missing_maps': sum(e['compact']['recovery_gap'] == 'missing_map' for e in compactions)}}
    if (root / 'planning-results.json').exists():
        planning = json.loads((root / 'planning-results.json').read_text())
        on = next(x for x in planning['cases'] if x['side'] == 'on')
        off = next(x for x in planning['cases'] if x['side'] == 'off')
        advisory = [e for e in events.values() if e['type'] == 'coordination.advisory' and set(e['peers']) == {on['owner'], on['peer']}]
        owner_status = [output(c) for c in calls('planning-on-owner-observes') if c['tool'] == 'trace_status']
        peer_status = [output(c) for c in calls('planning-on-forced-overlap') if c['tool'] == 'trace_status']
        pair_refs = {e['ref'] for e in advisory}
        forced_stage = next(s for s in stages if s['name'] == 'planning-on-forced-overlap')
        result['planning'] = {'on_changed_path': on['alternate'] == 'WORKER_B' and on['overlap'] == 'INITIAL\n',
                              'off_wrote_original_path': off['overlap'] == 'WORKER_B' and off['alternate'] is None,
                              'forced_write_completed': planning['forced_native_write'] == 'FORCED_WRITE',
                              'forced_turn_exit': forced_stage['exit'],
                              'pair_advisories': len(advisory),
                              'both_real_sessions_observed_advisory': all(states and any(a['ref'] in pair_refs for a in states[-1]['advisories']) for states in [owner_status, peer_status])}
    if (root / 'storage-failure-results.json').exists():
        actual = calls('storage-failure-native')
        statuses = [output(c) for c in actual if c['tool'] == 'trace_status']
        result['storage_failure'] = {'trace_returned_error': bool(statuses and statuses[0]['ok'] is False),
                                     'native_tools_completed': all(any(c['tool'] == name and c['state']['status'] == 'completed' for c in actual) for name in ['shell', 'read', 'write']),
                                     'native_file_correct': (work / 'on-storage-failure' / 'survival.txt').read_text().strip() == 'STORE_FAILURE_NATIVE_OK'}
    if (root / 'glm-existing-history-result.json').exists():
        glm = json.loads((root / 'glm-existing-history-result.json').read_text())
        response = answer('\n'.join(glm['texts']), expected)
        result['glm_cross_server_recovery'] = {'model': glm['model'], 'exit': glm['exit'], 'correct': sum(response[k] == v for k, v in expected.items()),
                                               'total': len(expected), 'elapsed_seconds': glm['elapsed_seconds'], 'tools': glm['tools']}
    (root / 'verified-evidence.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory')
    verify(parser.parse_args().directory)
