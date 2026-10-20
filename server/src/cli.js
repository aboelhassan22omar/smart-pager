import fs from 'node:fs';
import path from 'node:path';
import { hashPin, PIN_RE } from './auth.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { HttpError } from './errors.js';
import { createShop } from './routes/admin.js';
import { Store } from './store.js';

const USAGE = `Smart Pager CLI

  node src/cli.js create <id> <name> <pin> [dynamic|static|both]
  node src/cli.js pin <id> <newPin>
  node src/cli.js list
`;

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, 'pager.db'));
const store = new Store(db, config);
const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'create') {
    const [id, name, pin, qrMode] = args;
    const { urls } = await createShop(store, config, { id, name, pin, qrMode });
    console.log(`Created shop "${id}"`);
    console.log(`  bar:      ${urls.bar}`);
    console.log(`  qr:       ${urls.qr}`);
    console.log(`  settings: ${urls.settings}`);
  } else if (command === 'pin') {
    const [id, pin] = args;
    if (!store.getShop(id)) throw new HttpError(404, `No shop "${id}"`);
    if (!PIN_RE.test(pin ?? '')) throw new HttpError(400, 'PIN must be 4-8 digits');
    store.updateShop(id, { pin_hash: await hashPin(pin) });
    console.log(`PIN updated for "${id}" (existing bar sessions are signed out)`);
  } else if (command === 'list') {
    const shops = store.listShops();
    if (!shops.length) console.log('No shops yet.');
    for (const s of shops) console.log(`${s.id}\t${s.qr_mode}\t${s.name}`);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof HttpError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  db.close();
}
