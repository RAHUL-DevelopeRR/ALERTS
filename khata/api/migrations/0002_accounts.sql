-- v2 accounts (additive). Existing paired devices keep user_id NULL / client NULL and work unchanged.
-- Passwords are stretched on the client (PBKDF2-SHA256, see shared/protocol.ts); the server stores only
-- pw_verifier = hex HMAC-SHA256(PEPPER, client_key) and compares it in constant time.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  shop_id        TEXT NOT NULL REFERENCES shops(id),
  username       TEXT NOT NULL CHECK (length(username) BETWEEN 3 AND 32 AND username = lower(username)
                                      AND username NOT GLOB '*[^a-z0-9._-]*'),
  display_name   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner','staff')),
  pw_salt        TEXT,                      -- base64url, 16 bytes, chosen by the client
  pw_iterations  INTEGER,                   -- PBKDF2 iterations the client used
  pw_verifier    TEXT,                      -- hex HMAC-SHA256(PEPPER, client_key); NULL = no password (Google only)
  google_email   TEXT,                      -- lower case; pre-registered by the owner
  google_sub     TEXT,                      -- set on the first Google sign-in with google_email
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  disabled_at    TEXT,
  failed_count   INTEGER NOT NULL DEFAULT 0, -- password failures since the last successful login
  locked_until   TEXT,                      -- exponential backoff after 5 failures; never permanent
  UNIQUE (username),
  UNIQUE (google_sub)
);
CREATE INDEX users_shop ON users(shop_id);
CREATE UNIQUE INDEX users_google_email ON users(google_email) WHERE google_email IS NOT NULL;

ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id);        -- NULL = v1 paired device
ALTER TABLE devices ADD COLUMN client TEXT CHECK (client IN ('android','web'));
ALTER TABLE devices ADD COLUMN expires_at TEXT;                         -- web sessions: absolute expiry
CREATE INDEX devices_user ON devices(user_id);

-- Failure backoff for usernames that do not exist (or are disabled), so a lockout answer looks the same for real and
-- unknown usernames. Same rules as users.failed_count / locked_until.
CREATE TABLE login_throttle (
  username      TEXT PRIMARY KEY,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  updated_at    TEXT NOT NULL
);
CREATE INDEX login_throttle_updated ON login_throttle(updated_at);

-- Wrong password logins per UTC day (shop-wide throttle, like pair_failures). A throttle, never a lockout.
CREATE TABLE auth_failures (
  day              TEXT PRIMARY KEY,
  count            INTEGER NOT NULL DEFAULT 0,
  next_allowed_at  TEXT
);
