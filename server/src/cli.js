import { hashPin, PIN_RE } from './auth.js';
import { openStorage } from './bootstrap.js';
import { loadConfig } from './config.js';
import { HttpError } from './errors.js';
import { planView } from './plans.js';
import { branchUrls, provisionBrand, provisionBranch } from './provision.js';
import { checkPassword, USERNAME_RE } from './routes/super.js';
import { randomId } from './util.js';

const USAGE = `Smart Pager CLI

  node src/cli.js create <id> <name> <pin> [dynamic|static|both]    brand + branch with the same id
  node src/cli.js pin <branch> <newPin>
  node src/cli.js list

  node src/cli.js brand create <id> <name>
  node src/cli.js brand list
  node src/cli.js branch create <brand> <id> <name> <pin> [area]   id must be <brand>-<area>
  node src/cli.js branch list [brand]
  node src/cli.js branch pin <branch> <newPin>
  node src/cli.js branch suspend <branch>
  node src/cli.js branch resume <branch>
  node src/cli.js owner create <brand> <username> [password] [email]
  node src/cli.js owner reset <username> [password]
  node src/cli.js hash-password <password>                          value for SUPER_PASSWORD_HASH
`;

const args = process.argv.slice(2);

// hash-password needs no storage (and must not create a data dir as a side effect).
if (args[0] === 'hash-password') {
  if (!args[1]) {
    console.error('Usage: node src/cli.js hash-password <password>');
    process.exit(1);
  }
  checkPassword(args[1]);
  const hash = await hashPin(args[1]);
  console.log(hash);
  // The hash contains "$": unquoted, docker compose would treat parts of it as variables.
  console.error(`
Put it in .env in SINGLE quotes:
SUPER_PASSWORD_HASH='${hash}'`);
  process.exit(0);
}

const quietLog = { info() {}, warn: console.warn, error: console.error, debug() {} };
const config = loadConfig();
const { control, tenants } = openStorage(config, quietLog);
const deps = { config, control, tenants };
const audit = (action, extra = {}) => control.audit({ actor: 'cli', action, ...extra });

function printUrls(id) {
  const urls = branchUrls(config, id);
  console.log(`  bar:      ${urls.bar}`);
  console.log(`  qr:       ${urls.qr}`);
  console.log(`  settings: ${urls.settings}`);
}

function branchOrFail(id) {
  const ctx = tenants.get(id);
  if (!ctx?.store.getShop()) throw new HttpError(404, `No branch "${id}"`);
  return ctx;
}

async function setPin(id, pin) {
  const ctx = branchOrFail(id);
  if (!PIN_RE.test(pin ?? '')) throw new HttpError(400, 'PIN must be 4-8 digits');
  ctx.store.updateShop({ pin_hash: await hashPin(pin) });
  audit('branch.pin_reset', { brandId: ctx.branch.brand_id, branchId: id });
  console.log(`PIN updated for "${id}" (existing bar sessions are signed out)`);
}

function listBranches(brandId) {
  const branches = brandId ? control.branchesOfBrand(brandId) : control.listBranches();
  if (!branches.length) console.log('No branches yet.');
  for (const b of branches) {
    const plan = planView(b);
    const left = plan.daysLeft == null ? '' : ` (${plan.daysLeft}d)`;
    console.log(`${b.brand_id}\t${b.id}\t${plan.status}${left}\t${b.name}`);
  }
}

async function main([command, sub, ...rest]) {
  if (command === 'create') {
    const [id, name, pin, qrMode] = [sub, ...rest];
    if (!control.getBrand(id)) provisionBrand(deps, { id, name });
    await provisionBranch(deps, { brandId: id, id, name, pin, qrMode });
    audit('branch.create', { brandId: id, branchId: id });
    console.log(`Created shop "${id}"`);
    printUrls(id);
  } else if (command === 'pin') {
    await setPin(sub, rest[0]);
  } else if (command === 'list') {
    listBranches();
  } else if (command === 'brand' && sub === 'create') {
    const [id, name] = rest;
    provisionBrand(deps, { id, name });
    audit('brand.create', { brandId: id });
    console.log(`Created brand "${id}"`);
  } else if (command === 'brand' && sub === 'list') {
    for (const b of control.listBrands()) console.log(`${b.id}\t${control.branchesOfBrand(b.id).length} branches\t${b.name}`);
  } else if (command === 'branch' && sub === 'create') {
    const [brandId, id, name, pin, area] = rest;
    await provisionBranch(deps, { brandId, id, name, pin, area });
    audit('branch.create', { brandId, branchId: id });
    console.log(`Created branch "${id}" (trial ${config.trialDays} days)`);
    printUrls(id);
  } else if (command === 'branch' && sub === 'list') {
    listBranches(rest[0]);
  } else if (command === 'branch' && sub === 'pin') {
    await setPin(rest[0], rest[1]);
  } else if (command === 'branch' && (sub === 'suspend' || sub === 'resume')) {
    const ctx = branchOrFail(rest[0]);
    control.setSuspended(ctx.branch.id, sub === 'suspend');
    audit(`branch.${sub}`, { brandId: ctx.branch.brand_id, branchId: ctx.branch.id });
    console.log(`${ctx.branch.id}: ${planView(control.getBranch(ctx.branch.id)).status}`);
  } else if (command === 'owner' && sub === 'create') {
    const [brandId, username, given, email] = rest;
    if (!control.getBrand(brandId)) throw new HttpError(404, `No brand "${brandId}"`);
    if (!USERNAME_RE.test(username ?? '')) throw new HttpError(400, 'username: 3-32 of a-z 0-9 . _ -');
    if (control.ownerByUsername(username)) throw new HttpError(409, `Username "${username}" is taken`);
    const password = given ? checkPassword(given) : randomId(9);
    control.createOwner({ brandId, username, email: email ?? null, passwordHash: await hashPin(password) });
    audit('owner.create', { brandId, detail: { username } });
    console.log(`Owner "${username}" for brand "${brandId}"\n  password: ${password}\n  login:    ${config.publicUrl}/brand/${brandId}`);
  } else if (command === 'owner' && sub === 'reset') {
    const [username, given] = rest;
    const owner = control.ownerByUsername(username ?? '');
    if (!owner) throw new HttpError(404, `No owner "${username}"`);
    const password = given ? checkPassword(given) : randomId(9);
    control.resetOwnerPassword(owner.id, await hashPin(password));
    audit('owner.reset', { brandId: owner.brand_id, detail: { username } });
    console.log(`Password reset for "${username}" (other sessions signed out)\n  password: ${password}`);
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
}

try {
  await main(args);
} catch (err) {
  console.error(err instanceof HttpError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  tenants.closeAll();
  control.close();
}
