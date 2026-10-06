CREATE TABLE auth_identities (
  google_sub TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE auth_flows (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_flows_expiry ON auth_flows(expires_at);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES auth_identities(user_id)
);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);
