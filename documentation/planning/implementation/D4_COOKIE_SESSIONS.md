# D4 — Sessions that survive a reload (owner decision 4, 2026-11-14)

Status: design, revised after Codex review msg_1794683376753 (unbounded reuse evidence; session-bound reissue; durable
operation identities across reload; cross-tab coordination). Built on Codex's D4 notes (msg_1794658919870). Branch `m0/d4-cookie-sessions` on
`m0/d3-pharmacy-pending-cancel`.

## Today

One OTP route for every role (`POST /auth/:userType/verify`) returns a 30-day HS256 bearer JWT (no `jti`/`aud`). Only
customer tokens are revocable (`authVersion`); staff tokens cannot be revoked. No refresh, logout or cookie support. The
web apps keep the token in memory (`credentials: 'omit'`), so a reload signs out. The default `CORS_ORIGIN='*'` with
`credentials: true` reflects any origin.

## Topology (pinned)

Each web app is served from its own HTTPS host, and that host forwards `/api/*` to the backend (exactly what the dev
servers do today). So every API call from a web app is **same-origin**: session cookies are first-party, host-only,
`SameSite=Strict`, and one app's cookie is never sent to the other app. No cross-site cookies (no third-party cookie
dependency). Release builds set `VITE_API_BASE_URL` empty. A frontend served from another site cannot use cookie
sessions; it keeps bearer-only (as today).

## Model

- **Access token**: JWT, **15 minutes**, in memory only (unchanged handling in the apps). New claims: `sid` (session id),
  `aud` (`customer` | `workspace`), `auth_time` (time of the OTP login, never refreshed).
- **Refresh token**: `sid.gen.mac`, mac = HMAC-SHA256(key derived from the server secret, `sid.gen`), sent only as an
  HttpOnly cookie. Nothing secret is stored. Only the family's current `gen` is accepted; a correctly signed token of an
  older generation is proof of reuse for the family's whole lifetime (no bounded history); an unsigned or forged value
  proves nothing and revokes nothing.
- **`auth_sessions`** collection, one row per login (a "family"):
  `{ _id: sid, audience, userType, userId, authTime, absoluteExpiresAt, idleExpiresAt, gen, authVersion (customers),
  revokedAt?, revokeReason?, createdAt, lastRefreshAt }`. Indexes: `{userId, userType, revokedAt}`, TTL on
  `absoluteExpiresAt` (+30 days).
- Lifetimes: customer idle 14 days / absolute 30 days; staff idle 12 hours / absolute 7 days. Refresh never extends the
  absolute expiry and never changes `authTime`.

## Cookies

`__Host-sd_rt` (customer host) and `__Host-sd_staff_rt` (workspace host): `HttpOnly; Secure; SameSite=Strict; Path=/;
Max-Age=<min(idle, absolute)>`. `__Host-` forbids `Domain`, so each cookie stays on its own app host. Token responses
carry `Cache-Control: no-store`; tokens are never logged.

Development (`NODE_ENV=development` only, explicit `SESSION_COOKIE_INSECURE_DEV=true`): names without `__Host-` and
without `Secure`, for `http://127.0.0.1` dev servers. Refused in any other environment at start-up.

## Audience and origin (login CSRF, fail closed)

Config: `SESSION_ORIGINS_CUSTOMER`, `SESSION_ORIGINS_WORKSPACE` (exact origins, comma-separated). Every session command
(`create`, `refresh`, `logout`) requires:
1. an `Origin` header exactly in one of the lists — missing, `null` or unlisted → 403 (no fallback to CORS);
2. the custom header `X-Jansetu-Session: 1` (a cross-site form cannot set it; a cross-site fetch would need a preflight
   that is refused);
3. JSON body.
The audience is derived from the Origin on the server, never from the request body; customer origins only create/refresh
`user` sessions, workspace origins only staff roles (`admin`, `pharmacy`, later `hr`/`specialist`).

CORS: `credentials: true` is removed for any origin not in an explicit list; `CORS_ORIGIN='*'` keeps working for
bearer-only clients (mobile apps) without credentials. Session cookies are first-party anyway (topology above).

## Session creation (no old bearer can start a family)

`POST /auth/:userType/verify` gains `{"session": "cookie"}`. With it (and the origin checks above), the same request that
consumes the single-use OTP creates the `auth_sessions` row, sets the cookie and returns a 15-minute access token. The
plain 30-day bearer response stays for existing mobile clients. There is no endpoint that turns an existing bearer token
into a session.

## Refresh (rotation with reuse detection)

`POST /auth/session/refresh`:
1. Origin/header checks; read the audience's cookie; hash it.
2. Verify the MAC; one atomic `findOneAndUpdate({ _id: sid, gen, audience, revokedAt: null, absoluteExpiresAt > now,
   idleExpiresAt > now }, { gen: gen + 1, idleExpiresAt: min(now + idle, absolute), lastRefreshAt })`.
3. No match: if the family's current `gen` is newer than the signed one → **reuse**: revoke the family
   (`reuse_detected`), clear the cookie, 401. Otherwise 401 and clear the cookie.
4. Account checks on every refresh: customer `authVersion` must equal the session's (sign-out-everywhere wins);
   staff `isActive` (and for pharmacies the operational check) must still hold. Failing → revoke, 401.
5. New access token with the same `sid` and `auth_time`.

Clients serialise refresh across tabs with the Web Locks API (`navigator.locks.request('sd-refresh')`), and every tab
reads the latest cookie, so normal concurrency never presents an old token. A lost response (server rotated, client did
not get the cookie) is detected as reuse on the next refresh and ends the session — fail closed; the user signs in again.

## Logout and revocation

- `POST /auth/session/logout`: revokes this session (`logout`), clears the cookie. Idempotent.
- "Sign out everywhere": customers keep `POST /auth/sessions/revoke` (advances `authVersion`) and it also revokes all
  their `auth_sessions`. Staff get the same endpoint, which ends their **cookie sessions** only: legacy sid-less staff
  bearer tokens (mobile/old clients) are still not revocable (no staff credential version yet; recorded follow-up).
- **Access tokens with a `sid` are checked on every request** (`authenticate`/`authenticateOptional`: one indexed read
  of the session's `revokedAt` and expiries). So logout and revocation take effect immediately, not after 15 minutes.
  Tokens without `sid` (legacy 30-day bearer) keep today's behaviour.

## Every token issuer

Three places sign tokens: OTP verify, and the two authenticated email-proof flows (personal / corporate email), which
issue a replacement token. A **session-bound caller** (token with `sid`) gets a session-bound replacement: same `sid`,
`aud`, `auth_time`, 15 minutes — never a sid-less 30-day bearer, so logout still ends it. Legacy callers keep the legacy
token. Refresh issues only session-bound tokens.

## Web clients: one identity, coordinated (Codex finding 4)

- Login (OTP verify), refresh and logout run under one cross-tab Web Lock per app; tabs announce identity changes on a
  BroadcastChannel (signed in as X / signed out). A tab whose identity changed elsewhere clears all identity-scoped
  state (queries, session memory, pending markers) and shows the sign-in screen.
- Refresh returns the `principal` ({userId, userType, sid}). A token is installed only when its principal matches the
  tab's current one (or the tab is restoring after a reload); otherwise the tab signs out locally.
- A 401 triggers at most one refresh; the request is retried (same body, same request key) only if the renewed token
  belongs to the same principal. Never under another identity.

## Unresolved once-only operations across a reload (Codex finding 3)

Before each send, a once-only operation (customer return, supplier return, booking create) stores a marker in the
tab's `sessionStorage`: `{requestKey, kind, scope id (order / inventory item / doctor), firstAttemptAt, lastAttemptAt}`
under the principal's id — no request body, no names, no health data, no credentials. After a reload the screen restores
the marker and blocks a new submission of that kind for that scope until either the server shows the record carrying the
key (existing receipt look-up by key; bookings list carries `createRequestKey`) or the request is provably dead: not
found more than 5 minutes after its last attempt (the server writes these in MongoDB transactions, which cannot commit
after 60 seconds). Routine token renewal never touches in-memory pending operations. Markers are cleared on resolution,
proven death, sign-out and identity change.

## Native (Capacitor) protocol — specified, implemented with the native shell

Same `auth_sessions` rows with `audience: 'native'`; the refresh token is returned in the body and kept in the OS secure
store; `POST /auth/session/refresh` with `{ refreshToken }` and no cookie, same CAS rotation, reuse detection, account
checks and expiries; no Origin requirement (native requests have no web origin) but requires the native app header.
Not implemented in this packet.

## Also in this packet

- `authenticateOptional`: an invalid/expired token becomes 401 (today it is a 500).
- Private file responses add `Vary: Cookie` next to `Vary: Authorization`.
- Web apps: `credentials: 'same-origin'` only for the three session commands (all other calls keep `'omit'`); on start
  they call refresh; access tokens are refreshed ~1 minute before expiry and on a 401 once; sign-out calls logout.

## Not in this packet (recorded)

- OTP attempt limits / rate limiting (no limit today; a 6-digit code is guessable within its 10 minutes). Strongly
  recommended before release; separate packet.
- Shortening or retiring the legacy 30-day bearer for mobile.

## Tests (planned)

Create via verify (origin/header/audience checks, no session from an old bearer); refresh rotates once under concurrency
(one winner, loser 401 without reuse when using the new cookie); reuse of an old token revokes the family; idle and
absolute expiry; customer sign-out-everywhere and staff deactivation end refresh; logout ends the access token
immediately; cross-audience cookie/origin refused; missing/null/unlisted Origin refused; `authenticateOptional` bad
token 401.
