#!/usr/bin/env python3
"""Deterministic model fixture; tools/permissions/compaction execute in real OpenCode.

No production runtime dependency. Bind loopback, run only for the test, then stop.
The control file supplies cases; request headers and credentials are never logged.
"""
import argparse
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def serve(port, control, receipts):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages = body.get('messages', [])
            text = json.dumps(messages)
            cases = json.loads(Path(control).read_text())
            matches = re.findall(r'TRACE_CASE=([a-z0-9_]+)', text)
            case_id = next((m for m in reversed(matches) if m in cases), 'default')
            case = cases.get(case_id, {})
            names = [t.get('function', {}).get('name') for t in body.get('tools', [])]
            outputs = {m.get('tool_call_id') for m in messages if m.get('role') == 'tool'}
            operations = case.get('operations', [])
            next_op = next(((i, op) for i, op in enumerate(operations) if f'call_{case_id}_{i}' not in outputs), None)
            last_user = next((m.get('content', '') for m in reversed(messages) if m.get('role') == 'user'), '')
            last_user = last_user if isinstance(last_user, str) else json.dumps(last_user)
            compacting = '## Objective' in last_user or 'summary template' in last_user or ('summary' in last_user.lower() and 'TRACE_CASE=' not in last_user)
            if not names or compacting:
                delta = {'role': 'assistant', 'content': case.get('compact', 'Native fixture summary. Completed native operations and retained source history.')}
                finish = 'stop'
            elif next_op:
                i, op = next_op
                delta = {'role': 'assistant', 'content': None, 'tool_calls': [{'index': 0, 'id': f'call_{case_id}_{i}', 'type': 'function',
                    'function': {'name': op['name'], 'arguments': json.dumps(op['arguments'])}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': f'TRACE_FIXTURE_DONE {case_id}'}
                finish = 'stop'
            recalls = []
            for message in messages:
                content = message.get('content', '')
                if not isinstance(content, str): content = json.dumps(content)
                if 'OPENCODE_TRACE_RECALL_V1' in content:
                    recalls.append(content[content.index('OPENCODE_TRACE_RECALL_V1'):])
            with open(receipts, 'a') as f:
                f.write(json.dumps({'at': time.time(), 'case': case_id, 'model': body.get('model'), 'tool_names': names,
                    'received_tool_ids': sorted(x for x in outputs if x), 'recalls': recalls, 'last_user': last_user, 'response': delta, 'finish': finish}) + '\n')
            if body.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                def emit(d, reason=None):
                    chunk = {'id': 'chatcmpl-trace-fixture', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': body.get('model'),
                        'choices': [{'index': 0, 'delta': d, 'finish_reason': reason}]}
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                emit(delta); emit({}, finish)
                self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'id': 'chatcmpl-trace-fixture', 'object': 'chat.completion', 'created': int(time.time()), 'model': body.get('model'),
                    'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode())

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'fixture ready on {server.server_port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18177)
    parser.add_argument('--control', required=True)
    parser.add_argument('--receipts', required=True)
    args = parser.parse_args()
    serve(args.port, args.control, args.receipts)
