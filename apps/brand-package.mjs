// Builds one brand package from a template exactly like the server does, for checking it with the
// platform's own tools in CI (apksigner, aapt2):
//   node apps/brand-package.mjs android apps/android/build/cashier-template.apk out.apk
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackages } from '../server/src/native/packages.js';

const [platform, template, out] = process.argv.slice(2);
const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-native-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-data-'));
fs.copyFileSync(template, path.join(nativeDir, platform === 'android' ? 'cashier-template.apk' : 'cashier-template.exe'));
const packages = createPackages({ config: { nativeDir, dataDir, publicUrl: 'https://pager.example.com' } });
const pkg = packages.build(platform, { id: 'demo-brand', name: 'كافيه التجربة', appKey: 'ci-app-key' });
fs.writeFileSync(out, pkg.data);
console.log(`${out}: ${pkg.data.length} bytes`);
fs.rmSync(nativeDir, { recursive: true, force: true });
fs.rmSync(dataDir, { recursive: true, force: true });
