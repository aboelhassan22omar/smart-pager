// Nightly backups (DESIGN §20): VACUUM INTO of control.db and every branch DB, plus the
// branch media folders and secrets.json, into $DATA_DIR/backups/<YYYY-MM-DD>/. Kept 7 days.
// Optional off-site copy to S3 (never secrets.json). Restore = copy a day folder over /data.

import fs from 'node:fs';
import path from 'node:path';
import { vacuumInto } from './migrations.js';
import { putObject } from './s3.js';
import { dayIn } from './util.js';

export const KEEP_DAYS = 7;
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_AT = { hour: 3, minute: 30 };

const backupsDir = (config) => path.join(config.dataDir, 'backups');
const statusFile = (config) => path.join(backupsDir(config), 'status.json');

export function backupStatus(config) {
  try {
    return JSON.parse(fs.readFileSync(statusFile(config), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(config, status) {
  fs.mkdirSync(backupsDir(config), { recursive: true });
  fs.writeFileSync(statusFile(config), JSON.stringify(status, null, 2));
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Day folders older than KEEP_DAYS days are removed (pre-migrate copies are left alone). */
export function pruneBackups(config, today) {
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - (KEEP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const removed = [];
  for (const name of fs.existsSync(backupsDir(config)) ? fs.readdirSync(backupsDir(config)) : []) {
    if (DAY_DIR_RE.test(name) && name < cutoff) {
      fs.rmSync(path.join(backupsDir(config), name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

async function uploadOffsite(config, dayDir, day) {
  const s3 = config.backupS3;
  let uploaded = 0;
  for (const rel of listFiles(dayDir)) {
    if (rel === 'secrets.json') continue; // never leaves the server
    await putObject(s3, `${s3.prefix}${day}/${rel}`, fs.readFileSync(path.join(dayDir, rel)));
    uploaded += 1;
  }
  return uploaded;
}

/**
 * One full backup. Each DB is copied with VACUUM INTO (consistent while the app runs).
 * A branch that fails is logged and reported; the others still get backed up.
 */
export async function runBackup({ config, control, tenants, log }, { now = Date.now() } = {}) {
  const day = dayIn(config.tz, new Date(now));
  const dayDir = path.join(backupsDir(config), day);
  const partial = `${dayDir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  const errors = [];
  let branches = 0;

  vacuumInto(control.db, path.join(partial, 'control.db'));
  for (const branch of control.listBranches()) {
    try {
      const ctx = tenants.get(branch.id);
      if (!ctx) continue;
      const dest = path.join(partial, 'tenants', branch.brand_id, branch.id);
      vacuumInto(ctx.store.db, path.join(dest, 'pager.db'));
      fs.cpSync(ctx.mediaDir, path.join(dest, 'media'), { recursive: true });
      branches += 1;
    } catch (err) {
      log?.error({ err, branch: branch.id }, 'branch backup failed');
      errors.push(`${branch.id}: ${err.message}`);
    }
  }
  const secrets = path.join(config.dataDir, 'secrets.json');
  if (fs.existsSync(secrets)) fs.copyFileSync(secrets, path.join(partial, 'secrets.json'));

  // Swap in the finished folder (a re-run on the same day replaces it).
  fs.rmSync(dayDir, { recursive: true, force: true });
  fs.renameSync(partial, dayDir);
  const pruned = pruneBackups(config, day);

  let offsite = null;
  if (config.backupS3) {
    try {
      offsite = { ok: true, files: await uploadOffsite(config, dayDir, day) };
    } catch (err) {
      log?.error({ err }, 'off-site backup upload failed');
      offsite = { ok: false, error: err.message };
      errors.push(`S3: ${err.message}`);
    }
  }

  const status = { day, at: now, ok: errors.length === 0, branches, errors, pruned, offsite };
  writeStatus(config, status);
  log?.info({ day, branches, errors: errors.length }, 'backup finished');
  return status;
}

/** Runs once a day, at or after 03:30 local time (catches up after a restart). */
export function backupDue(config, now = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
  if (p.hour * 60 + p.minute < BACKUP_AT.hour * 60 + BACKUP_AT.minute) return false;
  return backupStatus(config)?.day !== dayIn(config.tz, new Date(now));
}

export function scheduleBackups(deps) {
  let running = false;
  const tick = async () => {
    if (running || !backupDue(deps.config)) return;
    running = true;
    try {
      await runBackup(deps);
    } catch (err) {
      deps.log?.error({ err }, 'backup failed');
      writeStatus(deps.config, { day: dayIn(deps.config.tz), at: Date.now(), ok: false, branches: 0, errors: [err.message] });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
