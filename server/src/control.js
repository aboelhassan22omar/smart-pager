import { DatabaseSync } from 'node:sqlite';
import { PRAGMAS, runMigrations } from './migrations.js';

// Control database: the registry only (brands, branches). No order or customer data.
export const CONTROL_MIGRATIONS = [
  `
  CREATE TABLE brands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE branches (
    id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL REFERENCES brands (id),
    name TEXT NOT NULL,
    area TEXT,
    db_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER
  );
  CREATE INDEX branches_brand ON branches (brand_id);
  `,
];

export const branchDbPath = (brandId, branchId) => `tenants/${brandId}/${branchId}/pager.db`;

export class ControlStore {
  constructor(db) {
    this.db = db;
    const p = (sql) => db.prepare(sql);
    this.sql = {
      brand: p('SELECT * FROM brands WHERE id = ?'),
      brands: p('SELECT * FROM brands ORDER BY created_at'),
      insertBrand: p('INSERT INTO brands (id, name, created_at) VALUES (?, ?, ?)'),
      branch: p('SELECT * FROM branches WHERE id = ?'),
      branches: p('SELECT * FROM branches ORDER BY brand_id, created_at'),
      branchIds: p('SELECT id FROM branches ORDER BY id'),
      insertBranch: p(`INSERT INTO branches (id, brand_id, name, area, db_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
      rename: p('UPDATE branches SET name = ? WHERE id = ?'),
      touch: p('UPDATE branches SET last_activity_at = ? WHERE id = ?'),
    };
  }

  ping() {
    return this.db.prepare('SELECT 1 AS ok').get().ok === 1;
  }

  getBrand(id) {
    return this.sql.brand.get(id);
  }

  listBrands() {
    return this.sql.brands.all();
  }

  createBrand({ id, name, createdAt = Date.now() }) {
    this.sql.insertBrand.run(id, name, createdAt);
    return this.getBrand(id);
  }

  getBranch(id) {
    return this.sql.branch.get(id);
  }

  listBranches() {
    return this.sql.branches.all();
  }

  branchIds() {
    return this.sql.branchIds.all().map((r) => r.id);
  }

  createBranch({ id, brandId, name, area = null, createdAt = Date.now() }) {
    this.sql.insertBranch.run(id, brandId, name, area, branchDbPath(brandId, id), createdAt);
    return this.getBranch(id);
  }

  renameBranch(id, name) {
    this.sql.rename.run(name, id);
  }

  touch(id, at = Date.now()) {
    this.sql.touch.run(at, id);
  }

  close() {
    this.db.close();
  }
}

export function openControl(file, { backupFile } = {}) {
  const db = new DatabaseSync(file);
  db.exec(PRAGMAS);
  runMigrations(db, CONTROL_MIGRATIONS, { backupFile });
  return new ControlStore(db);
}
