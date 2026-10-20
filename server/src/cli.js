import { hashPin, PIN_RE } from './auth.js';
import { openStorage } from './bootstrap.js';
import { loadConfig } from './config.js';
import { HttpError } from './errors.js';
import { branchUrls, provisionBrand, provisionBranch } from './provision.js';

const USAGE = `Smart Pager CLI

  node src/cli.js create <id> <name> <pin> [dynamic|static|both]   brand + branch with the same id
  node src/cli.js pin <branch> <newPin>
  node src/cli.js list
`;

const quietLog = { info() {}, warn: console.warn, error: console.error, debug() {} };
const config = loadConfig();
const { control, tenants } = openStorage(config, quietLog);
const deps = { config, control, tenants };
const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'create') {
    const [id, name, pin, qrMode] = args;
    if (!control.getBrand(id)) provisionBrand(deps, { id, name });
    await provisionBranch(deps, { brandId: id, id, name, pin, qrMode });
    const urls = branchUrls(config, id);
    console.log(`Created shop "${id}"`);
    console.log(`  bar:      ${urls.bar}`);
    console.log(`  qr:       ${urls.qr}`);
    console.log(`  settings: ${urls.settings}`);
  } else if (command === 'pin') {
    const [id, pin] = args;
    const ctx = tenants.get(id);
    if (!ctx?.store.getShop()) throw new HttpError(404, `No branch "${id}"`);
    if (!PIN_RE.test(pin ?? '')) throw new HttpError(400, 'PIN must be 4-8 digits');
    ctx.store.updateShop({ pin_hash: await hashPin(pin) });
    console.log(`PIN updated for "${id}" (existing bar sessions are signed out)`);
  } else if (command === 'list') {
    const branches = control.listBranches();
    if (!branches.length) console.log('No branches yet.');
    for (const b of branches) {
      const shop = tenants.get(b.id)?.store.getShop();
      console.log(`${b.brand_id}\t${b.id}\t${shop?.qr_mode ?? '-'}\t${b.name}`);
    }
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof HttpError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  tenants.closeAll();
  control.close();
}
