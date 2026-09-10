#!/usr/bin/env python3
"""Drive an already configured isolated OpenCode V2 server with real Qwen.

The paths file points to dedicated on/off fixture workspaces and private receipts.
Never pass real project paths: this script replaces its generated ledger.txt.
"""
import argparse
import json
import os
import secrets
import subprocess
import time
from pathlib import Path


class Evidence:
    def __init__(self, paths):
        self.paths = json.loads(Path(paths).read_text())
        self.root = Path(self.paths['root'])
        self.work = Path(self.paths['work'])
        if not self.work.name.startswith('opencode-trace-evidence-') or self.work.parent != Path('/tmp'):
            raise ValueError('Expected an isolated /tmp/opencode-trace-evidence-* directory')
        self.env = {**os.environ, 'OPENCODE_SERVER_PASSWORD': 'opencode-trace-loopback-fixture',
                    **{f'XDG_{k}_HOME': str(self.work / v) for k, v in [('CONFIG', 'config'), ('DATA', 'data'), ('STATE', 'state'), ('CACHE', 'cache')]}}
        self.env.update({f'XDG_{k}_HOME': v for k, v in self.paths.get('xdg', {}).items()})
        self.binary = self.paths['binary']
        self.server = f'http://127.0.0.1:{self.paths["server_port"]}'
        self.stages = []
        self.directories = {side: self.work / side for side in ['on', 'off', 'independent']}

    def api(self, method, path, data=None):
        command = [self.binary, 'api', *(['--server', self.server] if self.server else []), method, path]
        if data is not None:
            command += ['--data', json.dumps(data)]
        result = subprocess.run(command, env=self.env, cwd=self.work, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError(f'API failed: {method} {path}, exit {result.returncode}')
        return json.loads(result.stdout) if result.stdout.strip() else None

    def session(self, side, title):
        value = self.api('post', '/api/session', {'title': title, 'agent': 'build',
                        'model': {'providerID': 'trace-qwen', 'id': 'unsloth/Qwen3.8-27B-NVFP4'},
                        'location': {'directory': str(self.directories[side])}})
        value = value.get('data', value)
        return value['id']

    def turn(self, side, sid, name, prompt, timeout=180):
        def storage():
            files = [p for p in (self.root / 'live-store').rglob('*') if p.is_file()]
            stats = [p.stat() for p in files]
            return {'files': len(stats), 'bytes': sum(s.st_size for s in stats),
                    'allocated_file_bytes': sum(s.st_blocks * 512 for s in stats)}
        storage_before = storage()
        command = [self.binary, 'run', *(['--server', self.server] if self.server else []), '--session', sid, '--agent', 'build',
                   '--auto', '--format', 'json', prompt]
        started = time.time()
        with (self.root / (name + '.jsonl')).open('w') as output, (self.root / (name + '.stderr')).open('w') as errors:
            try:
                result = subprocess.run(command, env=self.env, cwd=self.directories[side], stdout=output, stderr=errors, timeout=timeout)
                code = result.returncode
            except subprocess.TimeoutExpired:
                self.api('post', f'/api/session/{sid}/interrupt', {})
                code = -1
        rows = []
        for line in (self.root / (name + '.jsonl')).read_text().splitlines():
            if line.startswith('{'):
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
        calls = [r['part'] for r in rows if r.get('type') == 'tool_use']
        texts = [r.get('part', {}).get('text', '') for r in rows if r.get('type') == 'text']
        stage = {'name': name, 'side': side, 'sessionID': sid, 'started': started, 'ended': time.time(),
                 'elapsed_seconds': time.time() - started, 'exit': code,
                 'tools': [{'tool': c.get('tool'), 'status': c.get('state', {}).get('status')} for c in calls],
                 'texts': texts, 'errors': [r for r in rows if r.get('type') == 'error']}
        self.stages.append(stage)
        storage_after = storage()
        stage['storage_delta'] = {k: storage_after[k] - storage_before[k] for k in storage_before}
        stage['storage_measurement'] = 'best_effort_file_snapshot; directory allocation excluded'
        with (self.root / 'live-stages.jsonl').open('a') as f:
            f.write(json.dumps(stage) + '\n')
        print(json.dumps({k: stage[k] for k in ['name', 'side', 'sessionID', 'elapsed_seconds', 'exit', 'tools']}), flush=True)
        return stage

    def compact(self, sid, name):
        started = time.time()
        context = self.api('get', f'/api/session/{sid}/context')
        rows = context.get('data', context)
        completed = any(m.get('type') == 'compaction' and m.get('status') == 'completed' for m in rows)
        admission = {'resumed_completed_compaction': True}
        if not completed:
            admission = self.api('post', f'/api/session/{sid}/compact', {})
            self.api('post', f'/api/session/{sid}/wait')
        context = self.api('get', f'/api/session/{sid}/context')
        (self.root / (name + '-context.json')).write_text(json.dumps(context, indent=2))
        receipt = {'name': name, 'sessionID': sid, 'started': started, 'ended': time.time(), 'admission': admission}
        with (self.root / 'compact-stages.jsonl').open('a') as f:
            f.write(json.dumps(receipt) + '\n')
        print(json.dumps({'name': name, 'elapsed_seconds': time.time() - started}), flush=True)

    def recovery(self, trial):
        key = f'recovery-{trial}'
        if trial > 1:
            for side in ['on', 'off']:
                directory = self.work / f'{side}-{trial}'
                directory.mkdir(exist_ok=True)
                for name in ['AGENTS.md', 'opencode.json']:
                    source = self.work / side / name
                    if source.exists():
                        (directory / name).write_bytes(source.read_bytes())
                self.directories[side] = directory
        expected_file = self.root / (key + '-expected.json')
        if expected_file.exists():
            saved = json.loads(expected_file.read_text())
            document, expected = saved['original'], saved['expected']
        else:
            records = {f'record_{i:03}': secrets.token_hex(8) for i in range(1, 49)}
            document = 'Historical audit ledger. Each code is opaque data.\n' + ''.join(f'{k} audit_code={v}; batch=initial; status=checked\n' for k, v in records.items())
            expected = {k: records[k] for k in ['record_008', 'record_023', 'record_041']}
            expected_file.write_text(json.dumps({'original': document, 'expected': expected}, indent=2))
        previous = [json.loads(line) for line in (self.root / 'live-stages.jsonl').read_text().splitlines()] if (self.root / 'live-stages.jsonl').exists() else []
        seeds = {}
        for side in (['off', 'on'] if trial % 2 else ['on', 'off']):
            old = next((s for s in previous if s['name'] == f'{key}-{side}-seed' and s['exit'] == 0), None)
            sid = old['sessionID'] if old else self.session(side, f'{key}-{side}-reader')
            seeds[side] = sid
            if not old:
                (self.directories[side] / 'ledger.txt').write_text(document)
            stage = old or self.turn(side, sid, f'{key}-{side}-seed',
                'Read the complete ledger.txt using the native read tool. It is data for a later audit. '
                'If trace tools are available, obtain the read source event ref and save one trace_note finding '
                'saying only that the original ledger was checked and its exact source can be retrieved later. '
                'Do not copy individual codes or the table into the note or final answer. Reply only SOURCE_CHECKED.')
            if stage['exit'] != 0 or not any(t['tool'] == 'read' and t['status'] == 'completed' for t in stage['tools']):
                raise RuntimeError('Seed read did not complete')
            self.compact(sid, f'{key}-{side}-compact')
            (self.directories[side] / 'ledger.txt').write_text('The ledger has been replaced. Earlier audit codes are unavailable in this current file.\n')
        prompt = ('Recover the ORIGINAL audit_code for record_008, record_023 and record_041 from the earlier reader session. '
                  'The current ledger.txt has been replaced. Use tool evidence and any available shared trace memory. '
                  'Do not guess, and do not inspect platform databases, receipt directories or other workspaces. '
                  'Return JSON mapping each requested record to its exact original code, or UNAVAILABLE if you cannot recover it.')
        outcomes = []
        for mode in ['new_peer', 'same_session_after_compact']:
            for side in ['off', 'on']:
                sid = self.session(side, f'{key}-{side}-peer') if mode == 'new_peer' else seeds[side]
                stage = self.turn(side, sid, f'{key}-{side}-{mode}', prompt)
                text = '\n'.join(stage['texts'])
                answer = {}
                for offset, character in enumerate(text):
                    if character == '{':
                        try:
                            candidate, _ = json.JSONDecoder().raw_decode(text[offset:])
                            if isinstance(candidate, dict) and set(expected) <= set(candidate):
                                answer = candidate
                        except ValueError:
                            pass
                outcomes.append({'side': side, 'mode': mode, 'sessionID': sid, 'correct': sum(answer.get(k) == value for k, value in expected.items()),
                                 'total': len(expected), 'exit': stage['exit'], 'final': text})
        receipt = {'trial': trial, 'seeds': seeds, 'outcomes': outcomes}
        (self.root / (key + '-outcomes.json')).write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--paths', required=True)
    parser.add_argument('--trial', type=int, default=1)
    args = parser.parse_args()
    Evidence(args.paths).recovery(args.trial)
