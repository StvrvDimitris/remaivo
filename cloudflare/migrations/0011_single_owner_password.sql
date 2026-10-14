-- Remaivo now belongs to one owner who signs in with a password.
-- The password itself is the REMAIVO_PASSWORD secret, or (self-hosted without
-- that secret) this single PBKDF2 hash chosen on first visit.
CREATE TABLE IF NOT EXISTS auth_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A server with exactly one Google identity hands it to the password owner,
-- keeping the same user ID so all existing data stays theirs.
UPDATE auth_identities SET google_sub = 'password:owner' WHERE (SELECT COUNT(*) FROM auth_identities) = 1;
-- Google sessions and sign-in flows no longer apply.
DELETE FROM auth_sessions;
DROP TABLE IF EXISTS auth_flows;
