#!/usr/bin/env python3
"""Loopback proxy for isolated synthetic Qwen sessions; never records headers.

Only use with a dedicated test provider. Raw message bodies can contain session
data; keep the output directory private. This is not a production dependency.
"""
import argparse
import json
import time
import uuid
import urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def serve(port, upstream, directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            with urllib.request.urlopen(upstream + self.path, timeout=10) as response:
                self.send_response(response.status)
                self.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                self.end_headers()
                self.wfile.write(response.read())

        def do_POST(self):
            size = int(self.headers['Content-Length'])
            if size > 2 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(size)
            request = json.loads(body)
            identifier = str(time.time_ns()) + '-' + uuid.uuid4().hex[:8]
            (directory / (identifier + '.request.json')).write_text(json.dumps(request))
            messages = request.get('messages', [])
            recalls = []
            for message in messages:
                content = message.get('content', '')
                if isinstance(content, list):
                    content = '\n'.join(p.get('text', '') for p in content if p.get('type') == 'text')
                if isinstance(content, str) and 'OPENCODE_TRACE_RECALL_V1' in content:
                    section = content[content.index('OPENCODE_TRACE_RECALL_V1'):]
                    view = None
                    for line in section.splitlines():
                        try:
                            candidate = json.loads(line)
                            if isinstance(candidate, dict) and 'sessionID' in candidate:
                                view = candidate
                        except (ValueError, TypeError):
                            pass
                    recalls.append({'bytes': len(section.encode()), 'view': view})
            summary = {'id': identifier, 'started': time.time(), 'model': request.get('model'),
                       'request_bytes': size, 'message_count': len(messages),
                       'message_bytes': len(json.dumps(messages).encode()),
                       'tool_schema_bytes': len(json.dumps(request.get('tools', [])).encode()),
                       'tool_names': [t.get('function', {}).get('name') for t in request.get('tools', [])],
                       'recalls': recalls, 'usage': None, 'tool_calls': []}
            chunks = []
            try:
                forwarded = urllib.request.Request(upstream + self.path, data=body, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(forwarded, timeout=180) as response:
                    self.send_response(response.status)
                    content_type = response.headers.get('Content-Type', 'application/json')
                    self.send_header('Content-Type', content_type)
                    self.end_headers()
                    if 'text/event-stream' in content_type:
                        for line in response:
                            chunks.append(line)
                            self.wfile.write(line)
                            self.wfile.flush()
                            if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
                                item = json.loads(line[6:])
                                if item.get('usage'):
                                    summary['usage'] = item['usage']
                                for choice in item.get('choices', []):
                                    for call in choice.get('delta', {}).get('tool_calls', []):
                                        if call.get('function', {}).get('name'):
                                            summary['tool_calls'].append(call['function']['name'])
                    else:
                        chunks.append(response.read())
                        self.wfile.write(chunks[0])
                        summary['usage'] = json.loads(chunks[0]).get('usage')
                summary['status'] = 'completed'
            except Exception as error:
                summary['status'] = type(error).__name__
                try:
                    self.send_error(502)
                except OSError:
                    pass
            finally:
                summary['elapsed_seconds'] = time.time() - summary['started']
                (directory / (identifier + '.response')).write_bytes(b''.join(chunks))
                (directory / (identifier + '.summary.json')).write_text(json.dumps(summary, indent=2))
                print(json.dumps({k: summary[k] for k in ['id', 'status', 'elapsed_seconds', 'tool_calls']}), flush=True)

    print(f'Qwen evidence proxy listening on 127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18178)
    parser.add_argument('--upstream', default='http://127.0.0.1:18094')
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    serve(args.port, args.upstream, args.directory)
