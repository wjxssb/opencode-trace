// Test-process-only home and XDG state isolation. The real HOME is untouched.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'review-trace-worker-home-'));
os.homedir = () => sandbox;
process.env.XDG_DATA_HOME = path.join(sandbox, ".local", "share");
syncBuiltinESMExports();
process.on('exit', () => fs.rmSync(sandbox, { recursive: true, force: true }));
