// Runs `node --check` on every JS file in the project (server, browser, tests).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['src', 'public', 'test', 'scripts'];
const files = [path.join(root, 'eslint.config.js')];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

for (const d of dirs) walk(path.join(root, d));

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    process.stderr.write(res.stderr);
  }
}

console.log(`node --check: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
