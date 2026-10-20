import fs from 'node:fs';
import path from 'node:path';
import { openControl } from './control.js';
import { migrateFromV1 } from './migrate-v1.js';
import { createTenants } from './tenants.js';
import { upgradeLegacyReview } from './upgrades.js';

/** Storage for the server and the CLI: one-time v1 move, control DB, branch DB manager. */
export function openStorage(config, log) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  migrateFromV1({ dataDir: config.dataDir, log });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const control = openControl(path.join(config.dataDir, 'control.db'), {
    backupFile: path.join(config.dataDir, 'backups', `pre-migrate-${stamp}`, 'control.db'),
  });
  const tenants = createTenants({ dataDir: config.dataDir, control, config, cacheSize: config.tenantDbCache, log });
  upgradeLegacyReview({ control, tenants });
  return { control, tenants };
}
