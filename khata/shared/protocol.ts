/**
 * Kadan Kanakku sync protocol: the single contract shared by the Android app (khata/app)
 * and the Cloudflare Worker (khata/api). Both import this file by relative path.
 *
 * Ledger rules (see docs/GROCERY_DEBT_APP_PLAN.md):
 *  - Money is integer paise. Never floats.
 *  - Entries are append-only. A mistake is fixed by a REVERSAL entry (+ optionally a new corrected entry).
 *  - A customer's balance is SUM(delta_paise) over their entries (positive = customer owes the shop).
 *  - Every row id is a client-generated UUID v4 and doubles as the idempotency key.
 *  - Customer rows are last-write-wins in SERVER order (the row the server accepted last is current).
 *  - Ordering for sync is the server's append-only change log (`seq`), never row timestamps.
 */

export const API_VERSION = 'v1';
/** Max rows (customers + entries) in one POST /sync/push. The server answers 413 above this. */
export const MAX_PUSH_ROWS = 20;
/** Default and max page size for GET /sync/pull. */
export const PULL_PAGE_SIZE = 500;
/** Customer codes are handed to devices in blocks of this size. */
export const CODE_BLOCK_SIZE = 50;
/** Pairing codes are 8 decimal digits and live this many minutes. */
export const PAIR_CODE_TTL_MIN = 10;
/** Setup (first owner) pairing codes live longer, because the developer relays them by phone/WhatsApp. */
export const SETUP_CODE_TTL_MIN = 24 * 60;

export type Role = 'owner' | 'staff';
export type EntryKind = 'GIVE' | 'RECEIVE' | 'WRITEOFF' | 'REVERSAL';
export type PayMode = 'CASH' | 'UPI' | 'OTHER';
export type Lang = 'ta' | 'en';
export type Tbl = 'customers' | 'entries';

/**
 * Customer as it travels on the wire (push body and pull stream).
 * `code` is the human handle shown as C-0042 (the number 42).
 * `phone` is optional, E.164 (+91XXXXXXXXXX) when present, and NOT unique.
 * `updated_at`/`updated_by` are informational (phone clock + device id); `received_at` is the server clock.
 */
export interface CustomerRow {
  id: string;
  code: number;
  name: string;
  search_name: string | null;
  phone: string | null;
  note: string | null;
  archived_at: string | null;
  /** Set only by POST /customers/:id/erase. Terminal: later name/phone/note writes are refused (ERASED). */
  erased_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  /** Server-filled. Ignored in push bodies. */
  received_at?: string | null;
}

/**
 * Ledger entry on the wire.
 * delta_paise: +amount for GIVE, -amount for RECEIVE and WRITEOFF, exactly -(original.delta_paise) for REVERSAL.
 * biz_date: 'YYYY-MM-DD' business day in Asia/Kolkata (may be back-dated, never in the future).
 * A REVERSAL copies the original's customer_id, amount_paise, biz_date and mode.
 */
export interface EntryRow {
  id: string;
  customer_id: string;
  kind: EntryKind;
  amount_paise: number;
  delta_paise: number;
  biz_date: string;
  note: string | null;
  mode: PayMode | null;
  reverses_entry_id: string | null;
  /** Author device. In push bodies the server ignores this and uses the authenticated device. */
  device_id: string;
  created_at: string;
  /** Server-filled. Ignored in push bodies. */
  received_at?: string | null;
}

export interface ShopInfo {
  id: string;
  name: string;
  upi_id: string | null;
  lang: Lang;
}

export interface DeviceInfo {
  id: string;
  name: string;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  /** v2 (additive): how the device signed in. null/absent = paired with a code (v1) or an Android login. */
  client?: ClientKind | null;
  /** v2 (additive): the user account this device belongs to; null/absent = a v1 paired device. */
  user_id?: string | null;
}

/** Every successful JSON response from an authenticated route includes these. */
export interface Envelope {
  server_time: string;
  sync_epoch: string;
}

/** Error body for every non-2xx response. */
export interface ApiError {
  error: string;
  message?: string;
  /** Present on 401 for a revoked device whose owner asked to wipe the local copy. */
  wipe?: boolean;
  /** v2: seconds to wait, on 429 locked (also sent as the Retry-After header). */
  retry_after?: number;
  /** v2: on 403 stepup_required, which proofs this device can give: its password (client_key) and/or a recovery code. */
  stepup?: Array<'password' | 'recovery'>;
}

// ---------------------------------------------------------------- routes (all under /v1)

/** GET /v1/health  (no auth) -> { ok: true } after SELECT 1 */
export interface HealthResponse { ok: true }

/**
 * POST /v1/setup  (no bearer token; header `X-Setup-Key: <SETUP_KEY secret>`)
 * Creates the shop if none exists (using shop_name), otherwise reuses the existing one, and mints a
 * single-use OWNER pairing code valid SETUP_CODE_TTL_MIN minutes. If the SETUP_KEY secret is not set,
 * the route answers 404. Wrong key -> 403. This is the developer's bootstrap and last-resort recovery path.
 */
export interface SetupRequest { shop_name?: string }
export interface SetupResponse { shop: ShopInfo; code: string; expires_at: string }

/**
 * POST /v1/pair  (no bearer token; throttled, see API README)
 * `code` = an 8-digit pairing code or an owner recovery code (XXXX-XXXX-XXXX-XXXX; dashes/spaces/case ignored).
 * `max_local_code` = highest customer code this phone allocated before pairing (0..1,000,000, else 400); the server
 *   raises its customer-code sequence to at least this before issuing the first block, so codes never collide.
 * `previous_device_id` = this phone's old device id (if it was paired before); revoked in the same batch
 *   when it belongs to the same shop and its role is not above the claimed code's (a staff code never revokes an
 *   owner phone). The unused codes the old row issued (e.g. printed recovery codes) move to the new device.
 * Errors: 400 bad_request, 403 invalid_code (unknown/used/expired), 429 throttled. Recovery codes are never throttled.
 */
export interface PairRequest {
  code: string;
  device_name: string;
  max_local_code?: number;
  previous_device_id?: string;
}
export interface PairResponse extends Envelope {
  token: string;
  device_id: string;
  role: Role;
  shop: ShopInfo;
  code_block: { start: number; end: number };
}

/**
 * GET /v1/me -> who am I (cheap token check used by Settings).
 * v2: `user` is present when the device was created by a login (or linked with POST /users link_me).
 */
export interface MeResponse extends Envelope { device: DeviceInfo; shop: ShopInfo; user?: UserSummary | null }

/** POST /v1/devices/pair-code  (owner) -> new 8-digit code for another phone. */
export interface PairCodeRequest { role: Role }
export interface PairCodeResponse extends Envelope { code: string; expires_at: string; role: Role }

/** POST /v1/devices/recovery-codes  (owner). Replaces all unused recovery codes; plaintext shown once. */
export interface RecoveryCodesRequest { count?: number /* 3..5, default 5 */ }
export interface RecoveryCodesResponse extends Envelope { codes: string[] }

/** POST /v1/devices/code-block  (any) -> next CODE_BLOCK_SIZE customer codes for this device. */
export interface CodeBlockRequest { max_local_code?: number }
export interface CodeBlockResponse extends Envelope { start: number; end: number }

/** GET /v1/devices  (owner) */
export interface DevicesResponse extends Envelope { devices: DeviceInfo[] }

/**
 * POST /v1/devices/:id/revoke  (owner). A device cannot revoke itself (400). The unused pair and recovery codes the
 * revoked device issued are deleted in the same transaction (re-issue recovery codes if it minted the printed ones).
 */
export interface RevokeRequest { wipe?: boolean }
export interface OkResponse extends Envelope { ok: true }

/** PUT /v1/shop  (owner) */
export interface ShopUpdateRequest { name?: string; upi_id?: string | null; lang?: Lang }
export interface ShopUpdateResponse extends Envelope { shop: ShopInfo }

/**
 * POST /v1/customers/:id/erase  (owner). DPDP erasure: name/search_name/phone/note are overwritten with
 * "Erased <YYYY-MM-DD>" (search_name/phone/note -> null), erased_at and received_at = server clock,
 * one change-log row appended. Entries are kept. Returns the updated row.
 */
export interface EraseResponse extends Envelope { customer: CustomerRow }

/**
 * POST /v1/sync/push  (any). At most MAX_PUSH_ROWS rows (413 otherwise).
 * Customers are processed before entries. Each row gets exactly one result.
 * 500 batch_failed: a constraint failed inside the write batch (the client halves the chunk; a single-row chunk gets
 * BATCH_FAILED instead). 503 unavailable: transient database trouble, retry later (nothing is rejected).
 * When an accepted entry un-archives its customer, the server logs that change with device_id 'server', so every
 * device (including the pushing one) receives it through pull.
 */
export interface PushRequest { customers: CustomerRow[]; entries: EntryRow[] }
export type PushStatus = 'stored' | 'already' | 'rejected';
export interface PushResult {
  tbl: Tbl;
  id: string;
  status: PushStatus;
  /** Change-log seq of the row (stored: newly assigned; already: its latest seq). */
  seq?: number;
  reason?: RejectReason;
}
export interface PushResponse extends Envelope { results: PushResult[] }

/**
 * Rejection reasons. RETRIABLE ones stay in the client's outbox; the rest mark the row
 * sync_state='rejected' (excluded from every balance) and list it under "Needs attention".
 */
export type RejectReason =
  | 'BAD_ROW'              // malformed: missing/invalid fields, bad uuid, bad date format, name empty
  | 'BAD_AMOUNT'           // amount not a positive safe integer, or delta sign/size wrong for kind
  | 'FUTURE_DATE'          // biz_date later than server IST date + 1 day
  | 'UNKNOWN_CUSTOMER'     // RETRIABLE: customer not on server and not accepted in this push
  | 'UNKNOWN_ORIGINAL'     // RETRIABLE: reversal target not on server and not accepted in this push
  | 'ALREADY_REVERSED'     // target already has a reversal (client auto-resolves: hides its duplicate)
  | 'REVERSAL_OF_REVERSAL' // target is itself a REVERSAL
  | 'REVERSAL_MISMATCH'    // customer/amount/mode/biz_date differ from the original, or delta != -original.delta
  | 'ARCHIVE_NONZERO'      // archive requested while balance (server + this chunk) != 0
  | 'CODE_TAKEN'           // RETRIABLE: (shop, code) belongs to a different customer id; client reallocates code
  | 'ERASED'               // change to an erased customer
  | 'FORBIDDEN_ROLE'       // staff pushing WRITEOFF or an archive
  | 'MISMATCH'             // same id already stored with different canonical content
  | 'BATCH_FAILED';        // a single-row chunk still failed inside the DB batch

export const RETRIABLE_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  'UNKNOWN_CUSTOMER',
  'UNKNOWN_ORIGINAL',
  'CODE_TAKEN',
]);

/**
 * GET /v1/sync/pull?since=<seq>&limit=<n>  (any)
 * Returns change-log rows with seq > since, EXCLUDING rows authored by the calling device (except when since=0: a
 * full re-pull, e.g. after the local database was rebuilt, includes the caller's own rows), in seq order,
 * each joined to the row's CURRENT content. `next_since` = last seq examined in this page (advance the
 * cursor to it even if every row in the page was filtered out). Also returns the device list and shop.
 */
export type Change =
  | { seq: number; tbl: 'customers'; row: CustomerRow }
  | { seq: number; tbl: 'entries'; row: EntryRow };
export interface PullResponse extends Envelope {
  changes: Change[];
  next_since: number;
  has_more: boolean;
  devices: DeviceInfo[];
  shop: ShopInfo;
}

/** GET /v1/export  (owner) -> full JSON copy of the shop (streamed). */
export interface ExportFile {
  format: 'kadan-kanakku-export';
  version: 1;
  exported_at: string;
  shop: ShopInfo;
  devices: DeviceInfo[];
  customers: CustomerRow[];
  entries: EntryRow[];
}

/** Canonical (client-owned) fields compared for idempotent replays. Server-filled fields are excluded. */
export const ENTRY_CANONICAL_FIELDS = [
  'id', 'customer_id', 'kind', 'amount_paise', 'delta_paise', 'biz_date', 'note', 'mode',
  'reverses_entry_id', 'created_at',
] as const;
export const CUSTOMER_CANONICAL_FIELDS = [
  'id', 'code', 'name', 'search_name', 'phone', 'note', 'archived_at', 'updated_at', 'created_at',
] as const;

// ---------------------------------------------------------------- v2: accounts (additive; v1 pairing is unchanged)
//
// Passwords never reach the server. The client stretches them (Bitwarden-style) and sends only the result:
//   client_key = PBKDF2-HMAC-SHA256(password_utf8_NFC, base64url_decode(salt), iterations, 32 bytes)   (WebCrypto)
// and the server stores HMAC-SHA256(PEPPER, client_key), compared in constant time. This keeps every request far
// below the Workers Free 10 ms CPU limit; the 600,000-iteration cost is paid on the phone / in the browser.
// Bytes on the wire are base64url WITHOUT padding: salt = 16 bytes (22 chars), client_key = 32 bytes (43 chars).
//
// Sessions are device rows: every login creates a `devices` row exactly like POST /pair (own token, own customer-code
// block, authorship, pull skipping its own rows, revoke-with-wipe), so /sync/* is unchanged.
//   - client 'android' (and v1 paired phones): token returned in the body, sent as `Authorization: Bearer <token>`.
//   - client 'web': token is NOT returned (token: null). The server sets the cookie
//       kk_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=2592000 (30 days, also enforced
//       server side), and every cookie-authenticated request MUST carry the header `X-KK-Client: web` (CSRF guard,
//       any method; 403 {error:'csrf'} without it). Use fetch(..., {credentials: 'same-origin'}).
//   A web token is never accepted as a Bearer token and an app token never as a cookie (401 unauthorized).

/**
 * PBKDF2 iterations. The server stores ONLY the default count (OWASP's 600,000 for PBKDF2-HMAC-SHA256): a password
 * set with any other count is refused (400 'iterations'), so a weak client cannot register a cheap verifier and
 * /auth/prelogin can answer the same count for everyone (a different count would reveal that the user exists).
 * MIN/MAX are kept for forward compatibility; in this build they are both effectively the default.
 */
export const PBKDF2_MIN_ITERATIONS = 600_000;
export const PBKDF2_MAX_ITERATIONS = 2_000_000;
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;
/** Bytes of salt (client-generated, crypto.getRandomValues) and of the derived client_key. */
export const PW_SALT_BYTES = 16;
export const CLIENT_KEY_BYTES = 32;
/** Usernames: lower case, 3-32 chars of a-z 0-9 . _ - (the server lower-cases and trims what it receives). */
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
/** Name of the web session cookie, and the CSRF header the web app must send with it. */
export const SESSION_COOKIE = 'kk_session';
export const WEB_CLIENT_HEADER = 'X-KK-Client';
/** Web sessions end after this many days (cookie Max-Age and devices.expires_at). */
export const WEB_SESSION_DAYS = 30;
/** With `shared_computer: true` in the login body a web session ends after this many hours and the cookie has no Max-Age. */
export const WEB_SHARED_SESSION_HOURS = 12;
/** Step-up (see "Step-up" below): header carrying the caller's CURRENT client_key, or a printed recovery code. */
export const STEPUP_HEADER = 'X-KK-Stepup';
export const RECOVERY_HEADER = 'X-KK-Recovery';
/** A step-up proof keeps the device stepped up for this long (devices.stepup_until). */
export const STEPUP_WINDOW_MIN = 5;
/** Known-device value (see "Lockout" below): returned by every login as `known_device` (+ cookie kk_known on the web). */
export const KNOWN_DEVICE_HEADER = 'X-KK-Known';
export const KNOWN_DEVICE_COOKIE = 'kk_known';
/** An unlinked pre-registered google_email can be claimed for this long after the owner set it. */
export const GOOGLE_EMAIL_LINK_HOURS = 48;
/** A nonce from POST /auth/nonce is valid this long, once. */
export const NONCE_TTL_MIN = 10;
/** GET /auth/events returns at most this many rows (newest first). */
export const AUTH_EVENTS_LIMIT = 200;

export type ClientKind = 'android' | 'web';

/** The signed-in person, as returned by login and GET /me. */
export interface UserSummary {
  id: string;
  username: string;
  display_name: string;
  role: Role;
}

/** A user as listed to the owner (GET /v1/users). */
export interface UserInfo extends UserSummary {
  /** Lower-cased Google address the owner pre-registered for Google sign-in, or null. */
  google_email: string | null;
  /** True once that Google account signed in (its `sub` is linked). */
  google_linked: boolean;
  /**
   * While google_email is set but not linked: the instant until which its first Google sign-in may claim it
   * (GOOGLE_EMAIL_LINK_HOURS after the owner set it). null when linked or when there is no google_email. After it
   * passes the owner must set the address again (PUT /users/:id, with step-up).
   */
  google_email_expires_at: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

/**
 * GET /v1/config  (public). What the login screen should offer.
 * google_client_id: the web OAuth client id for Google Identity Services, or null when Google sign-in is off
 * (show the Google button only when it is a string).
 */
export interface ConfigResponse {
  google_client_id: string | null;
  auth: { password: true };
  /** Server build version, e.g. '2.0.0'. */
  version: string;
  server_time: string;
}

/**
 * POST /v1/auth/prelogin  (public, rate limited). Step 1 of a password login: fetch the PBKDF2 parameters.
 * For an unknown or disabled username (or a user without a password) the server answers with a deterministic fake
 * salt, in the same shape and status, so existence is not revealed. `iterations` is PBKDF2_DEFAULT_ITERATIONS for
 * EVERYONE (the server stores no other count).
 * Errors: 400 bad_request (username not matching USERNAME_RE), 429 throttled.
 */
export interface PreloginRequest { username: string }
export interface PreloginResponse { salt: string; iterations: number }

/**
 * Extras every login carries. `client` is what the client DECLARES; it is not a security boundary (anyone holding
 * credentials can claim 'android'), so owner-power routes gate on step-up, not on client kind.
 *
 * previous_device_id (+ previous_device_token): this client's old device row, revoked in the login batch and its
 * unused codes moved to the new row ONLY when (a) that row belongs to the same user as the login, or (b) it is a
 * legacy paired row (user_id NULL) AND previous_device_token is its still-valid bearer token (proof of possession).
 * Anything else (another user's device, a legacy id without its token) revokes nothing, silently: device ids are
 * visible to every phone through pulled entries. Recovery-kind codes are never moved onto a 'web' device (they stay
 * on the revoked row and keep working at /pair).
 *
 * shared_computer (web only): the session ends after WEB_SHARED_SESSION_HOURS and the cookie has no Max-Age
 * (dies with the browser). Staff when staff web arrives: the server will force it.
 */
export interface LoginExtras {
  device_name: string;
  client: ClientKind;
  max_local_code?: number;
  previous_device_id?: string;
  previous_device_token?: string;
  shared_computer?: boolean;
}

/**
 * POST /v1/auth/login  (public, rate limited). Step 2: send the derived key.
 *
 * Lockout is keyed on (username, source): source = the client's /24 (IPv4) or /48 (IPv6) from CF-Connecting-IP,
 * else 'unknown'. 5 failures lock that pair for 30 s, doubling to 15 min, never permanently; a successful login
 * resets it. An attacker therefore cannot lock the owner out from elsewhere. Known-device exemption: every
 * successful login returns `known_device` (the web also gets the cookie kk_known); a later login that carries it
 * (header X-KK-Known, or the cookie) for the SAME user is exempt from the per-source and shop-wide throttles and is
 * keyed on its own (username, device) backoff instead. The shop-wide daily budget (auth_failures, 429 throttled) is
 * charged only to failing unknown sources.
 *
 * Errors: 400 bad_request; 403 {error:'invalid_login'} for an unknown user AND for a wrong password (identical);
 * 403 {error:'web_owner_only'} for a staff user with client 'web' (credentials were right; use the phone app);
 * 429 {error:'locked', retry_after}; 429 {error:'throttled'}.
 */
export interface LoginRequest extends LoginExtras {
  username: string;
  /** base64url(PBKDF2(password, salt, iterations, 32 bytes)) using the PreloginResponse values. */
  client_key: string;
}

/**
 * Login answer: PairResponse-compatible plus the user. `token` is null for client 'web' (the session is in the
 * HttpOnly kk_session cookie); a string for 'android' (store it like a paired token).
 * `code_block` is null for client 'web': the web never creates customers offline; it syncs first and asks
 * POST /devices/code-block when it needs codes (so a browser does not burn 50 codes per login).
 * `known_device`: store it (Android: secure storage, sent later as X-KK-Known; web: the kk_known cookie is set too).
 * `expires_at`: when this session ends (web only), else null.
 */
export interface LoginResponse extends Omit<PairResponse, 'token' | 'code_block'> {
  token: string | null;
  code_block: { start: number; end: number } | null;
  user: UserSummary;
  known_device: string;
  expires_at: string | null;
}

/**
 * POST /v1/auth/nonce  (public, rate limited; 404 when Google sign-in is off) -> a single-use nonce valid
 * NONCE_TTL_MIN minutes. Pass it to Google Identity Services (`nonce` in google.accounts.id.initialize); the ID token
 * then carries it in its `nonce` claim and /auth/google requires it there (replay of a leaked token is refused).
 */
export interface NonceResponse { nonce: string }

/**
 * POST /v1/auth/google  (public, rate limited; 404 when the client kind's audience list is empty: GOOGLE_CLIENT_IDS
 * for 'web', GOOGLE_ANDROID_CLIENT_IDS for 'android').
 * `id_token` = the Google Identity Services credential (a JWT). The server checks the RS256 signature against
 * Google's JWKS, iss, aud (in the list for the declared client kind), exp/iat (5 min skew), email_verified and the
 * `nonce` claim (a live, unused nonce from POST /auth/nonce; consumed here). It signs in only a user the owner
 * pre-registered: google_sub already linked, or google_email equal (case-insensitive), not yet linked and set less
 * than GOOGLE_EMAIL_LINK_HOURS ago (then links it). Never creates users.
 * Errors: 400 bad_request; 403 {error:'invalid_token', message} (message 'nonce' for a missing/used/expired nonce);
 * 403 {error:'not_linked'} (valid Google account, but no user at this shop has it, or the pre-registration expired);
 * 403 {error:'web_owner_only'} (staff on the web).
 */
export interface GoogleLoginRequest extends LoginExtras { id_token: string }

/** POST /v1/auth/logout  (any session). Revokes the calling device and clears the cookie. -> OkResponse */

// ---------------------------------------------------------------- v2: step-up, web restrictions, audit
//
// Owner-power routes: POST /users, PUT /users/:id (role, google_email, disabled), PUT /users/:id/password for ANOTHER
// user, POST /devices/pair-code, POST /devices/recovery-codes, POST /devices/:id/revoke.
//  - client 'web' sessions are refused: 403 {error:'web_forbidden'} (GET /users and GET /auth/events stay readable).
//  - Every other caller must be stepped up: either the header `X-KK-Stepup: <client_key>` (the caller's CURRENT
//    client_key, derived exactly as for login; verified like a login and subject to the same 5-failure backoff) or
//    `X-KK-Recovery: <printed recovery code>` (consumed). A proof keeps the device stepped up for STEPUP_WINDOW_MIN
//    minutes (devices.stepup_until), so the client sends the header once per batch of actions.
//    Without a valid proof: 403 {error:'stepup_required', stepup: [...]}; a wrong one: 403 {error:'stepup_invalid'}
//    (429 locked after 5 wrong client_keys).
//  - Legacy paired devices (user_id NULL) step up with a recovery code. Bootstrap: while the shop has NO users at all,
//    a legacy owner phone keeps its v1 powers (no step-up), which is how it creates the first owner user with
//    link_me (and prints recovery codes) before accounts exist.
//  - The app PIN is a client-side guard only; the server cannot see it. Step-up is the server's check.

/** One row of the audit trail (GET /v1/auth/events, owner, newest first, at most AUTH_EVENTS_LIMIT). */
export interface AuthEvent {
  id: string;
  at: string;
  actor_device_id: string | null;
  actor_user_id: string | null;
  /**
   * login.ok | login.failed | login.locked | login.refused (web_owner_only) | google.ok | google.failed | logout |
   * stepup.ok | stepup.failed | user.create | user.update | password.change | password.reset |
   * pair_code.mint | recovery_codes.mint | device.revoke
   */
  action: string;
  target_user_id: string | null;
  target_device_id: string | null;
  /** Small JSON object (username, source, client, changed fields...); never credentials. */
  detail: Record<string, unknown> | null;
}
export interface AuthEventsResponse extends Envelope { events: AuthEvent[] }

/** GET /v1/users  (owner; web allowed) */
export interface UsersResponse extends Envelope { users: UserInfo[] }

/** Password material the client computes for a new password (fresh random 16-byte salt each time). */
export interface PasswordSet {
  salt: string;
  iterations: number;
  client_key: string;
}

/**
 * POST /v1/users  (owner device, step-up, not web). Creates a user of this shop. Password fields are all-or-nothing
 * (iterations must be PBKDF2_DEFAULT_ITERATIONS); a user without a password needs google_email (Google-only).
 * google_email must be @gmail.com / @googlemail.com, or the domain in the server's GOOGLE_HD var (400 bad_request,
 * message 'google_email_domain'); it can be claimed for GOOGLE_EMAIL_LINK_HOURS. `link_me: true` (only with role
 * 'owner', only from a device that has no user yet) also attaches the CALLING device to the new user: how a v1 paired
 * owner phone creates its login (no step-up needed while the shop has no users).
 * Errors: 400 bad_request, 400 already_linked, 409 username_taken, 409 google_email_taken, 403 forbidden,
 * 403 web_forbidden, 403 stepup_required / stepup_invalid.
 */
export interface CreateUserRequest extends Partial<PasswordSet> {
  username: string;
  display_name: string;
  role: Role;
  google_email?: string | null;
  link_me?: boolean;
}
export interface UserResponse extends Envelope { user: UserInfo }

/**
 * PUT /v1/users/:id  (owner device, not web; step-up when role, google_email or disabled is present).
 * Changing google_email unlinks the old Google account and restarts the GOOGLE_EMAIL_LINK_HOURS window.
 * disabled: true revokes all of that user's devices (and the unused codes they issued) in the same transaction;
 * disabled: false re-enables the login (devices stay revoked). A role change applies to the user's live devices.
 * Errors: 400 cannot_change_own_role, 400 cannot_disable_self, 409 last_owner (would leave no enabled owner user),
 * 409 google_email_taken, 404 not_found, 403 web_forbidden, 403 stepup_required / stepup_invalid.
 */
export interface UpdateUserRequest {
  display_name?: string;
  role?: Role;
  google_email?: string | null;
  disabled?: boolean;
}

/**
 * PUT /v1/users/:id/password. Any signed-in user (web included) may change their OWN password with
 * current_client_key (derived with the CURRENT salt from prelogin); their other devices are revoked. An owner device
 * (step-up, not web) may reset ANOTHER user's password; that user's devices are revoked.
 * Errors: 403 forbidden, 403 invalid_login (wrong current key), 403 web_forbidden, 403 stepup_required.
 */
export interface SetPasswordRequest extends PasswordSet { current_client_key?: string }
