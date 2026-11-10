# Outbound notification and Meet route containment

10 November 2026. Baseline `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`; branch `m0/batch3-outbound-guards`. Source-only M0-B work under the existing implementation approval. Production edits wait for two direct nonauthor contract reviews. No deployment, provider action, root build, TypeScript evaluation or Docker invocation is part of this slice.

## Actor and route contract

| Route | Allowed actor and order | Compatibility/effect boundary |
| --- | --- | --- |
| Notification `POST /` | Existing central `authenticate`, then route `requireAdmin`, body validation, existing controller | Admin retains existing single-recipient in-app creation. This endpoint does not itself send FCM |
| Notification `POST /send` | Existing central `authenticate`, then route `requireAdmin`, body validation, existing controller | Admin retains selected-user/corporate/all-patient notification and FCM path |
| Meet `GET /google-oauth/url` | Route `authenticate`, `requireAdmin`, existing validation/controller | Admin retains authorization URL tooling |
| Meet `POST /google-oauth/exchange` | Route `authenticate`, `requireAdmin`, existing validation/controller | Admin retains code exchange; no real token exchange is executed by this slice |
| Meet `POST /google-oauth/refresh` | Route `authenticate`, `requireAdmin`, existing validation/controller | Admin retains refresh-token tooling |
| Meet `POST /google-meet/oauth` | Route `authenticate`, `requireAdmin`, existing validation/controller | Admin retains meeting creation/invitation tooling |
| Meet `GET /google-oauth/callback` | Existing query validation/controller, with no bearer/admin guard | Google's browser redirect remains reachable; current controller only returns callback fields and performs no provider call |

Use the existing exact `userType === 'admin'` vocabulary through `requireAdmin`; no HR/specialist/pharmacy/user exception or request-selected authority. Missing/invalid credentials yield the existing 401; authenticated non-admins yield existing 403 before validation, controller, database or provider effects. Valid admin requests retain the existing validation/status/response behavior. Do not place a router-wide authentication guard over the callback.

Only two production files may change: `src1/modules/notification/routes/index.ts` and `src1/modules/meet/routes/index.ts`. Add the existing middleware imports and route guards only. Keep every other route registration, controller, service, schema, central mount, configuration and internal notification/booking-Meet call unchanged. Internal service calls remain available without routing through these administrative HTTP endpoints.

## Frozen source inputs (SHA-256)

| Path | Baseline hash |
| --- | --- |
| `src1/modules/notification/routes/index.ts` | `2635aa42a2b67d4b349a2fa4162d538cb60225e0b6d01a2598792124a8a7f6e3` |
| `src1/modules/meet/routes/index.ts` | `27ab67d1dad1bef4bd2a92c8b29f8b2b6621252bb535694e359c952b9a5fa81c` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `src1/modules/notification/services/index.ts` | `dd343357282c5c80fb02da2913d9eaf1ec772e7df0daa39f9a4b0bfc87c9311d` |
| `src1/modules/meet/controller/index.ts` | `94b5d080c86ed8b9bb0f1ba4a145ed67d9e51115bbb10e26013a30026bf7aff0` |

## Verification and retained gates

Before implementation, a retained standard-library Python verifier must reject the baseline's missing guards. After implementation it must accept the exact two-file transformation and unchanged remaining tracked files, reject removed/misordered/weakened guards and imports, reject callback gating, and verify the central authentication/middleware inputs. TypeScript is read as bytes, never imported, transpiled, extracted or evaluated. These checks prove the source transformation, not Express dispatch, JWT behavior or absence of runtime side effects.

Future executable acceptance requires full pre-import C3 and owned synthetic fixtures. For each of the six protected routes, exercise anonymous, expired/invalid JWT, ordinary user, HR, specialist and pharmacy actors with valid and malformed payloads: expected 401/403 and zero controller/repository/Google/FCM calls. Exercise valid admin inputs (existing result and allowed synthetic effects) and malformed admin inputs (existing validation errors). Exercise the public callback anonymously with valid code/state, provider error, missing code and invalid query: preserve existing response/validation behavior and zero provider calls. Include callback-with-no-bearer and an internal booking/notification caller compatibility check. A successful source scan cannot mark these cases PASS.

Trusted JWT issuance/key secrecy and outstanding-token controls remain prerequisites for effective role checks. This slice does not validate claims against current account state, revoke tokens, resolve contact takeover, harden the OAuth state/session lifecycle, authorize non-admin notification senders, or close remaining notification reads/updates/deletes, FCM test, dependents, public clinical files, webhook authentication or booking/money defects. Existing scenario outcomes remain unchanged. Deployment revision and protected operational evidence remain owner-controlled and withheld; no repeated request is needed.

The original six staged changes and eleven handover files must remain byte-identical. Source changes require separate Standards and Spec nonauthor reviews before integration; review decisions remain internal technical decisions, separate from runtime, security-owner and release acceptance.
