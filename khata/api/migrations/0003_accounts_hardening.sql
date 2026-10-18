-- v2 accounts hardening (additive; 0002 may already be applied, so this is a delta). Existing paired devices keep
-- working unchanged. See api/README.md "Accounts (v2)" and shared/protocol.ts "step-up, web restrictions, audit".

-- Step-up window: set when a device proves its password (X-KK-Stepup) or burns a recovery code (X-KK-Recovery).
ALTER TABLE devices ADD COLUMN stepup_until TEXT;

-- When the owner (re)set google_email. An unlinked address can be claimed by its first Google sign-in only for
-- GOOGLE_EMAIL_LINK_HOURS (48 h) after this instant; once google_sub is linked the window no longer matters.
ALTER TABLE users ADD COLUMN google_email_set_at TEXT;
-- Addresses pre-registered before this migration start their 48 h window now.
UPDATE users SET google_email_set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE google_email IS NOT NULL AND google_sub IS NULL AND google_email_set_at IS NULL;

-- Login backoff keyed on (username, source). source = client /24 (IPv4) or /48 (IPv6), 'unknown', or
-- 'known:<device id>' for a request carrying a valid known-device value, or 'stepup:<device id>' for X-KK-Stepup.
-- Replaces users.failed_count / users.locked_until and login_throttle (kept, no longer written).
CREATE TABLE login_locks (
  username      TEXT NOT NULL,
  source        TEXT NOT NULL,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (username, source)
);
CREATE INDEX login_locks_updated ON login_locks(updated_at);

-- Single-use nonces for Google sign-in (POST /auth/nonce -> ID token `nonce` claim). Rows expire with the nonce.
CREATE TABLE used_nonces (
  nonce_hash  TEXT PRIMARY KEY,             -- hex sha256(nonce || PEPPER)
  used_at     TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX used_nonces_exp ON used_nonces(expires_at);

-- Audit trail shown to owners (GET /v1/auth/events): logins, failures, lockouts, step-ups and every owner-power
-- action. shop_id is NULL only for failed logins that name no existing user. detail is a small JSON object and never
-- holds credentials. Rows older than 90 days are deleted opportunistically.
CREATE TABLE auth_events (
  id                TEXT PRIMARY KEY,
  shop_id           TEXT,
  at                TEXT NOT NULL,
  actor_device_id   TEXT,
  actor_user_id     TEXT,
  action            TEXT NOT NULL,
  target_user_id    TEXT,
  target_device_id  TEXT,
  detail            TEXT
);
CREATE INDEX auth_events_shop ON auth_events(shop_id, at);
