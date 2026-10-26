import { DatabaseSync } from 'node:sqlite';
import { PRAGMAS, runMigrations, tx } from './migrations.js';
import { effectivePlan } from './plans.js';

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
  // 2: plans, feature flags, brand owners, payments, audit log (phase 2).
  // Existing branches keep plan_status 'active' with no dates: no expiry until a first payment.
  `
  ALTER TABLE branches ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE branches ADD COLUMN trial_ends_at INTEGER;
  ALTER TABLE branches ADD COLUMN paid_until INTEGER;
  ALTER TABLE branches ADD COLUMN suspended_manual INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE branches ADD COLUMN ff_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE branches ADD COLUMN ff_loyalty INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE branches ADD COLUMN ff_promo INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE branches ADD COLUMN forced_off TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE owners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id TEXT NOT NULL REFERENCES brands (id),
    username TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    pw_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id TEXT NOT NULL REFERENCES branches (id),
    amount_egp INTEGER NOT NULL,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    note TEXT,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    brand_id TEXT,
    branch_id TEXT,
    detail TEXT,
    ip TEXT
  );
  CREATE INDEX audit_at ON audit_log (at);
  `,
  // 3: weekly owner summary bookkeeping (phase 3).
  `
  ALTER TABLE brands ADD COLUMN last_summary_week TEXT;
  `,
  // 4: sealed owner password (vault.js) the super can read back; trash (soft delete).
  //    deleted_reason: 'manual' | 'trial_ended' (automatic) | 'brand' (its brand was trashed).
  `
  ALTER TABLE owners ADD COLUMN password_sealed TEXT;
  ALTER TABLE brands ADD COLUMN deleted_at INTEGER;
  ALTER TABLE branches ADD COLUMN deleted_at INTEGER;
  ALTER TABLE branches ADD COLUMN deleted_reason TEXT;
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
      brandBranches: p('SELECT * FROM branches WHERE brand_id = ? ORDER BY created_at'),
      insertBranch: p(`INSERT INTO branches (id, brand_id, name, area, db_path, created_at, plan_status, trial_ends_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      rename: p('UPDATE branches SET name = ? WHERE id = ?'),
      touch: p('UPDATE branches SET last_activity_at = ? WHERE id = ?'),
      setTrial: p('UPDATE branches SET trial_ends_at = ? WHERE id = ?'),
      setPaidUntil: p('UPDATE branches SET paid_until = ? WHERE id = ?'),
      setSuspended: p('UPDATE branches SET suspended_manual = ? WHERE id = ?'),
      setForcedOff: p('UPDATE branches SET forced_off = ? WHERE id = ?'),
      setReviewFlag: p('UPDATE branches SET ff_review = ? WHERE id = ?'),
      setLoyaltyFlag: p('UPDATE branches SET ff_loyalty = ? WHERE id = ?'),
      setPromoFlag: p('UPDATE branches SET ff_promo = ? WHERE id = ?'),
      setPlanStatus: p('UPDATE branches SET plan_status = ? WHERE id = ?'),
      owner: p('SELECT * FROM owners WHERE id = ?'),
      ownerByName: p('SELECT * FROM owners WHERE username = ?'),
      brandOwners: p('SELECT id, brand_id, username, email, password_sealed, created_at, last_login_at FROM owners WHERE brand_id = ? ORDER BY id'),
      insertOwner: p('INSERT INTO owners (brand_id, username, email, password_hash, password_sealed, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      resetOwner: p('UPDATE owners SET password_hash = ?, password_sealed = ?, pw_version = pw_version + 1 WHERE id = ?'),
      renameOwner: p('UPDATE owners SET username = ? WHERE id = ?'),
      trashBranch: p('UPDATE branches SET deleted_at = ?, deleted_reason = ? WHERE id = ? AND deleted_at IS NULL'),
      restoreBranch: p('UPDATE branches SET deleted_at = NULL, deleted_reason = NULL WHERE id = ?'),
      trashBrand: p('UPDATE brands SET deleted_at = ? WHERE id = ?'),
      trashBrandBranches: p(`UPDATE branches SET deleted_at = ?, deleted_reason = 'brand' WHERE brand_id = ? AND deleted_at IS NULL`),
      restoreBrand: p('UPDATE brands SET deleted_at = NULL WHERE id = ?'),
      restoreBrandBranches: p(`UPDATE branches SET deleted_at = NULL, deleted_reason = NULL WHERE brand_id = ? AND deleted_reason = 'brand'`),
      ownerLogin: p('UPDATE owners SET last_login_at = ? WHERE id = ?'),
      insertPayment: p(`INSERT INTO payments (branch_id, amount_egp, period_start, period_end, note, actor, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      payments: p('SELECT * FROM payments WHERE branch_id = ? ORDER BY period_end DESC'),
      insertAudit: p('INSERT INTO audit_log (at, actor, action, brand_id, branch_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      audit: p('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
      markSummary: p('UPDATE brands SET last_summary_week = ? WHERE id = ?'),
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

  branchesOfBrand(brandId) {
    return this.sql.brandBranches.all(brandId);
  }

  /** `trialEndsAt` null = no trial (used for branches migrated from v1). */
  createBranch({ id, brandId, name, area = null, createdAt = Date.now(), trialEndsAt = null }) {
    const status = trialEndsAt == null ? 'active' : 'trial';
    this.sql.insertBranch.run(id, brandId, name, area, branchDbPath(brandId, id), createdAt, status, trialEndsAt);
    return this.getBranch(id);
  }

  // ---- plans ----

  setTrialEnd(id, at) {
    this.sql.setTrial.run(at, id);
  }

  setSuspended(id, suspended) {
    this.sql.setSuspended.run(suspended ? 1 : 0, id);
  }

  /** Owner toggle for one feature ('review' | 'loyalty' | 'promo'). */
  setFeature(id, feature, on) {
    const stmt = { review: this.sql.setReviewFlag, loyalty: this.sql.setLoyaltyFlag, promo: this.sql.setPromoFlag }[feature];
    if (!stmt) throw new Error(`unknown feature ${feature}`);
    stmt.run(on ? 1 : 0, id);
  }

  setForcedOff(id, features) {
    this.sql.setForcedOff.run(JSON.stringify([...new Set(features)].sort()), id);
  }

  /** Records a manual payment and moves paid_until forward to the period end (never back). */
  recordPayment(branchId, { amountEgp, periodStart, periodEnd, note = null, actor }) {
    return tx(this.db, () => {
      this.sql.insertPayment.run(branchId, amountEgp, periodStart, periodEnd, note, actor, Date.now());
      const branch = this.getBranch(branchId);
      if (branch.paid_until == null || periodEnd > branch.paid_until) this.sql.setPaidUntil.run(periodEnd, branchId);
      return this.getBranch(branchId);
    });
  }

  payments(branchId) {
    return this.sql.payments.all(branchId);
  }

  /**
   * Stores the computed status for dashboards (requests always recompute it), and moves
   * branches whose free trial ended unpaid to the trash. Returns the ids it trashed.
   */
  refreshPlanStatuses(now = Date.now()) {
    const trashed = [];
    for (const branch of this.listBranches()) {
      const plan = effectivePlan(branch, now);
      if (!branch.deleted_at && plan.reason === 'trial_ended') {
        this.trashBranch(branch.id, 'trial_ended', now);
        this.audit({ actor: 'system', action: 'branch.trash', brandId: branch.brand_id, branchId: branch.id, detail: { reason: 'trial_ended' } });
        trashed.push(branch.id);
        continue;
      }
      if (plan.status !== branch.plan_status) this.sql.setPlanStatus.run(plan.status, branch.id);
    }
    return trashed;
  }

  // ---- trash (soft delete) ----

  /** A trashed branch keeps all its data; customers can't take numbers until it's restored. */
  trashBranch(id, reason = 'manual', at = Date.now()) {
    this.sql.trashBranch.run(at, reason, id);
    this.sql.setPlanStatus.run('suspended', id);
  }

  restoreBranch(id) {
    this.sql.restoreBranch.run(id);
    const branch = this.getBranch(id);
    this.sql.setPlanStatus.run(effectivePlan(branch).status, id);
    return branch;
  }

  /** Trashing a brand trashes its live branches with it (reason 'brand'); restore brings back those only. */
  trashBrand(id, at = Date.now()) {
    tx(this.db, () => {
      this.sql.trashBrand.run(at, id);
      this.sql.trashBrandBranches.run(at, id);
    });
  }

  restoreBrand(id) {
    tx(this.db, () => {
      this.sql.restoreBrand.run(id);
      this.sql.restoreBrandBranches.run(id);
    });
    this.refreshPlanStatuses();
  }

  // ---- owners ----

  getOwner(id) {
    return this.sql.owner.get(id);
  }

  ownerByUsername(username) {
    return this.sql.ownerByName.get(username);
  }

  ownersOfBrand(brandId) {
    return this.sql.brandOwners.all(brandId);
  }

  createOwner({ brandId, username, email = null, passwordHash, passwordSealed = null }) {
    const res = this.sql.insertOwner.run(brandId, username, email, passwordHash, passwordSealed, Date.now());
    return this.getOwner(Number(res.lastInsertRowid));
  }

  /** New password; bumping pw_version signs every existing owner session out. */
  resetOwnerPassword(id, { passwordHash, passwordSealed = null }) {
    this.sql.resetOwner.run(passwordHash, passwordSealed, id);
    return this.getOwner(id);
  }

  /** Username only: sessions stay valid (they are bound to the owner id and password version). */
  renameOwner(id, username) {
    this.sql.renameOwner.run(username, id);
    return this.getOwner(id);
  }

  markOwnerLogin(id) {
    this.sql.ownerLogin.run(Date.now(), id);
  }

  markSummarySent(brandId, week) {
    this.sql.markSummary.run(week, brandId);
  }

  // ---- audit ----

  audit({ actor, action, brandId = null, branchId = null, detail = null, ip = null }) {
    this.sql.insertAudit.run(Date.now(), actor, action, brandId, branchId, detail == null ? null : JSON.stringify(detail), ip);
  }

  auditLog(limit = 100) {
    return this.sql.audit.all(limit).map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
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
