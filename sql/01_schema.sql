-- ============================================================
-- VCSS Social CRM  –  Database Schema
-- Run once in Supabase SQL Editor (Project: vcss-social)
-- ============================================================

-- 1. CONTACTS
CREATE TABLE IF NOT EXISTS contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sno               INTEGER,
  full_name         TEXT        NOT NULL,
  surname           TEXT,
  firstname         TEXT,
  salutation        TEXT,
  organisation      TEXT,
  designation       TEXT,
  phone             TEXT,
  email             TEXT,
  bio_context       TEXT,
  photo_filename    TEXT,
  genre             TEXT,
  subgenre          TEXT,
  location          TEXT,
  how_message_goes  TEXT,
  has_vc_met        BOOLEAN     DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 2. CATEGORIES  (Mumbai Dinner, Satsang, Bay Area 2025, etc.)
CREATE TABLE IF NOT EXISTS categories (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT    NOT NULL UNIQUE,
  slug          TEXT    NOT NULL UNIQUE,
  display_order INTEGER DEFAULT 0
);

-- 3. JOIN TABLE  (many-to-many)
CREATE TABLE IF NOT EXISTS contact_categories (
  contact_id  UUID REFERENCES contacts(id)  ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, category_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Only authenticated users can read; no public access.
-- Data is managed directly via Supabase dashboard / SQL Editor.
-- ============================================================

ALTER TABLE contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_categories ENABLE ROW LEVEL SECURITY;

-- SELECT for authenticated role only
CREATE POLICY "auth_read_contacts"
  ON contacts FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_categories"
  ON categories FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth_read_contact_categories"
  ON contact_categories FOR SELECT TO authenticated USING (true);

-- ============================================================
-- HELPER VIEW  (used by the app to fetch a category's contacts
-- pre-sorted: genre → subgenre → surname → firstname)
-- ============================================================

CREATE OR REPLACE VIEW category_contacts AS
  SELECT
    cc.category_id,
    c.*
  FROM contact_categories cc
  JOIN contacts c ON c.id = cc.contact_id;
