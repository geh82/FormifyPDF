-- FormForge AI Relational Schema (SQLite Runtime Migration 002)
-- Adds supporting_documents table for PDF and image attachments linked to documents or rendered outputs.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS supporting_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  generated_document_id TEXT REFERENCES generated_documents(id) ON DELETE CASCADE,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'supporting',
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  retention_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supporting_docs_tenant ON supporting_documents(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supporting_docs_doc ON supporting_documents(document_id);
CREATE INDEX IF NOT EXISTS idx_supporting_docs_gen ON supporting_documents(generated_document_id);
