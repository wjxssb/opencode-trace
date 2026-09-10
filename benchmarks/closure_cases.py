#!/usr/bin/env python3
"""Bounded real-host tests for targeted audit fixes, in disposable fixtures."""
import argparse
import json
from live_evidence import Evidence
from live_cases import fixture, probes

def failures(h):
    results = []
    for side in ['off', 'on']:
        target = fixture(h, side, 'closure-failure')
        if side == 'on':
            blocked = target / 'blocked-store'
            blocked.write_text('Intentional ENOTDIR fixture.\n')
            config = json.loads((target / 'opencode.json').read_text())
            config['plugins'][0]['options']['storeRoot'] = str(blocked)
            (target / 'opencode.json').write_text(json.dumps(config))
        sid = h.session(side, f'closure-failure-{side}')
        stage = h.turn(side, sid, f'closure-failure-{side}',
            'If trace_status is directly available, call it exactly once. Its storage is deliberately unavailable; '
            'accept the error without repairs or searching for other tools. Then use native write to create survival.txt '
            'containing BEFORE_EDIT, native read to read it, native edit to replace BEFORE_EDIT with STORE_FAILURE_NATIVE_OK, '
            'native read to verify, and native shell to run printf STORE_FAILURE_SHELL_OK. '
            'Keep all files in this fixture. Report the observed results briefly.')
        results.append({'side': side, 'stage': stage, 'file': (target / 'survival.txt').read_text() if (target / 'survival.txt').exists() else None})
    (h.root / 'closure-failure-results.json').write_text(json.dumps(results, indent=2))

def lifecycle(h):
    fixture(h, 'on', 'closure-lifecycle')
    owner = h.session('on', 'closure-lifecycle-owner')
    h.turn('on', owner, 'closure-lifecycle-declare',
        'Call trace_intent once to declare status active, summary planned fixture edit, path overlap.txt. '
        'Then reply DECLARED. Do not edit anything or change your declared status.')
    peer = h.session('on', 'closure-lifecycle-peer')
    h.turn('on', peer, 'closure-lifecycle-observe-completion',
        'Call trace_status once and briefly state the peer declaration and host observation. Do not call other tools.')
    deletion = h.api('delete', f'/api/session/{owner}')
    (h.root / 'closure-lifecycle-host-deletion.json').write_text(json.dumps({'deleted_owned_fixture_session': owner, 'native_api_result': deletion}, indent=2))
    h.turn('on', peer, 'closure-lifecycle-observe-deletion',
        'Call trace_status once and briefly state whether the peer intent declaration changed and whether explicit host deletion evidence is now visible. Do not call other tools.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--paths', required=True)
    parser.add_argument('case', choices=['failures', 'lifecycle', 'probes'])
    args = parser.parse_args()
    {'failures': failures, 'lifecycle': lifecycle, 'probes': probes}[args.case](Evidence(args.paths))
