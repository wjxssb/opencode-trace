#!/usr/bin/env python3
"""Additional controlled native-operation, planning, and storage-failure cases."""
import argparse
import json
from pathlib import Path
from live_evidence import Evidence


def fixture(h, side, name):
    target = h.work / f'{side}-{name}'
    target.mkdir(exist_ok=True)
    for filename in ['AGENTS.md', 'opencode.json']:
        source = h.work / side / filename
        if source.exists():
            (target / filename).write_bytes(source.read_bytes())
    h.directories[side] = target
    return target


def probes(h):
    for index in range(3):
        for side in (['off', 'on'] if index % 2 == 0 else ['on', 'off']):
            fixture(h, side, f'probe-{index}')
            sid = h.session(side, f'probe-{index}-{side}')
            h.turn(side, sid, f'probe-{index}-{side}',
                   f'Use only the native shell tool once to run printf TRACE_NATIVE_PROBE_{index}. '
                   'Do not use other tools. Then reply DONE.', timeout=90)


def planning(h):
    results = []
    owners = {}
    for side in ['off', 'on']:
        target = fixture(h, side, 'planning')
        (target / 'overlap.txt').write_text('INITIAL\n')
        owner = h.session(side, f'planning-{side}-owner')
        h.turn(side, owner, f'planning-{side}-owner',
               'You are worker A. You plan to edit overlap.txt later; keep that intent active. '
               'If trace_intent is directly available, declare this plan with status active and path overlap.txt. '
               'Otherwise simply state the plan. Do not search for tools and do not write any file yet.')
        peer = h.session(side, f'planning-{side}-peer')
        h.turn(side, peer, f'planning-{side}-peer',
               'You are worker B. Write the exact text WORKER_B to overlap.txt, unless another session declares '
               'an active intent for that same path. Inspect shared peer intents using trace_status if directly available. '
               'If there is an overlapping active intent, write WORKER_B to alternate.txt instead. '
               'If the trace tools are unavailable, use the available information without searching for extra tools. '
               'Do not read platform files. Report your chosen path.')
        results.append({'side': side, 'owner': owner, 'peer': peer,
                        'overlap': (target / 'overlap.txt').read_text(),
                        'alternate': (target / 'alternate.txt').read_text() if (target / 'alternate.txt').exists() else None})
        owners[side] = (owner, peer)
    owner, peer = owners['on']
    h.turn('on', peer, 'planning-on-forced-overlap',
           'Run this explicit diagnostic in the fixture: declare your own active trace_intent for overlap.txt, '
           'then use native write to put FORCED_WRITE in overlap.txt even if there is an advisory. '
           'Call trace_status afterward. Do not coordinate away this intentionally authorized test write.')
    h.turn('on', owner, 'planning-on-owner-observes',
           'Call trace_status once and report whether an overlap advisory with the other worker is visible. Do not change any file.')
    result = {'cases': results, 'forced_native_write': (h.directories['on'] / 'overlap.txt').read_text()}
    (h.root / 'planning-results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


def failure(h):
    target = fixture(h, 'on', 'storage-failure')
    blocked = target / 'blocked-store'
    blocked.write_text('This is a regular file, intentionally not a storage directory.\n')
    config = json.loads((target / 'opencode.json').read_text())
    config['plugins'][0]['options']['storeRoot'] = str(blocked)
    (target / 'opencode.json').write_text(json.dumps(config))
    sid = h.session('on', 'storage-failure-native')
    stage = h.turn('on', sid, 'storage-failure-native',
                   'Call trace_status once; this fixture deliberately has unavailable trace storage. '
                   'Accept that trace error without trying to repair it. Then use native write to create survival.txt '
                   'with STORE_FAILURE_NATIVE_OK, native read to read it, and native shell to run printf STORE_FAILURE_SHELL_OK. '
                   'All files must remain in this fixture. Report the real results.')
    result = {'sessionID': sid, 'exit': stage['exit'], 'native_file': (target / 'survival.txt').read_text() if (target / 'survival.txt').exists() else None}
    (h.root / 'storage-failure-results.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--paths', required=True)
    parser.add_argument('case', choices=['probes', 'planning', 'failure'])
    args = parser.parse_args()
    {'probes': probes, 'planning': planning, 'failure': failure}[args.case](Evidence(args.paths))
