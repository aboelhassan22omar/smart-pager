import fs from 'node:fs';
import path from 'node:path';
import { openBranchDb } from './db.js';
import { HttpError } from './errors.js';
import { BranchStore, SHOP_ID_RE } from './store.js';

/**
 * Opens branch databases lazily and keeps at most `cacheSize` handles open (LRU).
 * Every branch-scoped request works on the `ctx` returned here — never on a global store.
 */
export function createTenants({ dataDir, control, config, cacheSize = 200, log }) {
  const open = new Map(); // branchId -> { db, store, mediaDir } in LRU order (oldest first)

  const dirFor = (branch) => path.join(dataDir, 'tenants', branch.brand_id, branch.id);

  function evict() {
    while (open.size > cacheSize) {
      const [id, entry] = open.entries().next().value;
      open.delete(id);
      entry.db.close();
      log?.debug({ branch: id }, 'closed idle branch db');
    }
  }

  function backupFile(branch) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dataDir, 'backups', `pre-migrate-${stamp}`, 'tenants', branch.brand_id, branch.id, 'pager.db');
  }

  /** Branch context, or null when the id is invalid or unknown. */
  function get(branchId) {
    if (typeof branchId !== 'string' || !SHOP_ID_RE.test(branchId)) return null;
    const branch = control.getBranch(branchId);
    if (!branch) return null;
    let entry = open.get(branchId);
    if (entry) {
      open.delete(branchId);
    } else {
      const dir = dirFor(branch);
      const mediaDir = path.join(dir, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const db = openBranchDb(path.join(dir, 'pager.db'), { backupFile: backupFile(branch) });
      entry = { db, mediaDir, store: new BranchStore(db, { branchId, control, config }) };
    }
    open.set(branchId, entry);
    evict();
    return { branch, store: entry.store, mediaDir: entry.mediaDir };
  }

  /** Like get(), but 404s for unknown branches (and branches not set up yet). */
  function resolve(branchId) {
    const ctx = get(branchId);
    if (!ctx || !ctx.store.getShop()) throw new HttpError(404, 'المحل ده مش موجود');
    return ctx;
  }

  return {
    get,
    resolve,
    openCount: () => open.size,
    closeAll() {
      for (const entry of open.values()) entry.db.close();
      open.clear();
    },
  };
}
