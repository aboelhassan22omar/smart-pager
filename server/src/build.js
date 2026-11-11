import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from './paths.js';

// The version the pages run: a hash of every file under public/. A deploy that changes any of
// them gives a new id; open staff screens see it (a response header, the bar stream's hello)
// and reload themselves, so nobody keeps the old page until they happen to refresh.
let id = null;

function walk(dir, hash) {
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      walk(file, hash);
    } else {
      hash.update(path.relative(PUBLIC_DIR, file));
      hash.update(fs.readFileSync(file));
    }
  }
}

export function buildId() {
  if (!id) {
    const hash = createHash('sha256');
    try {
      walk(PUBLIC_DIR, hash);
    } catch {
      hash.update(String(Date.now()));
    }
    id = hash.digest('hex').slice(0, 12);
  }
  return id;
}
