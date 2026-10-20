import fs from 'node:fs';
import path from 'node:path';

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const quote = (p) => `'${p.replace(/'/g, "''")}'`;

/** Consistent copy of a live database (works with WAL, no locks held afterwards). */
export function vacuumInto(db, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO ${quote(file)}`);
}

/**
 * Numbered, idempotent migrations tracked by PRAGMA user_version; each step runs in its own
 * transaction. `backupFile`, when given, receives a VACUUM INTO copy before an *existing*
 * database (user_version > 0) is migrated.
 */
export function runMigrations(db, steps, { backupFile } = {}) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= steps.length) return 0;
  if (current > 0 && backupFile) vacuumInto(db, backupFile);
  for (let v = current; v < steps.length; v++) {
    tx(db, () => {
      db.exec(steps[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return steps.length - current;
}

export const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;';
