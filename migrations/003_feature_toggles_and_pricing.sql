-- FormifyPDF Relational Schema (SQLite Migration 003)
-- Feature Toggles and Pricing Tiers
PRAGMA foreign_keys = ON;

ALTER TABLE tenants ADD COLUMN top_tier_zip_upload INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN top_tier_zip_download INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN normal_upload INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD COLUMN normal_download INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS pricing_tiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_pages INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, max_pages)
);

-- Ensure default tenant exists before seeding pricing tiers
INSERT OR IGNORE INTO tenants (id, name, slug, retention_days)
VALUES ('tenant_default', 'Default Tenant', 'default', 30);

-- Insert default pricing tiers for the default tenant
INSERT OR IGNORE INTO pricing_tiers (id, tenant_id, name, max_pages, price_cents, description, is_active) VALUES
  ('tier_15_299', 'tenant_default', 'Up to 15 pages', 15, 299, 'Up to 15 pages — $2.99', 1),
  ('tier_30_599', 'tenant_default', 'Up to 30 pages', 30, 599, 'Up to 30 pages — $5.99', 1),
  ('tier_45_749', 'tenant_default', 'Up to 45 pages', 45, 749, 'Up to 45 pages — $7.49', 1),
  ('tier_60_999', 'tenant_default', 'Up to 60 pages', 60, 999, 'Up to 60 pages — $9.99', 1);
