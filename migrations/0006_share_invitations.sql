CREATE TABLE family_invitations (
  family_id INTEGER NOT NULL,
  inviter_id INTEGER NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  link_token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(family_id, inviter_id),
  FOREIGN KEY(family_id, inviter_id) REFERENCES family_members(family_id, user_id) ON DELETE CASCADE
);
