ALTER TABLE users ADD COLUMN preferred_role TEXT NOT NULL DEFAULT '家人';

CREATE TABLE family_codes (
  family_id INTEGER PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(8))))
);

INSERT INTO family_codes(family_id) SELECT id FROM families;
