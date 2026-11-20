ALTER TABLE family_codes ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
UPDATE family_codes SET expires_at=unixepoch()+604800;
