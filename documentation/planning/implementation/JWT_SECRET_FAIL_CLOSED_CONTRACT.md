# JWT secret fail-closed contract

10 November 2026. Branch `m0/authority-jwt-secret`, baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`. **PROPOSED; preimplementation review required.** Addresses the secret half of R06 (`documentation/planning/REPOSITORY_REVIEW.md:57`). Production scope: `src1/config/config.ts` only.

## Defect

`JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || 'your-secret-key'` (`config/config.ts:23`). The only startup check covers `MONGODB_URL`, and only when `NODE_ENV === 'production'` (`config.ts:109-118`), but `NODE_ENV` defaults to `'development'` (`:16`).

An unset key therefore becomes a public literal. The `.env.example:9` placeholder `your-secret-key-change-in-production` is also accepted as-is. With either value, anyone can mint a token with any `userType`, `_id` or `corporateId`, which defeats every route guard.

## Consumers

Every consumer reads `CONFIG.JWT_SECRET_KEY`; `src1` has no other secret source.

| Use | Location |
| --- | --- |
| Verify | `middleware/auth.ts:25` (`authenticate`, `authenticateOptional`) |
| Sign 30-day tokens | `auth/services/index.ts:415`, `576`, `734` |
| Getter | `settings/services/index.ts:51`. `SettingsService` is imported nowhere and is not mounted |

## Fail point: config load

Validate once, while the config module is evaluated, in every environment.

- **Safer.** It is one choke point, so no consumer can receive a bad key. A first-use check would start the process and report `/health` 200 while every login and authenticated call failed. It would also need edits at five call sites.
- **Less disruptive overall.** Failure is immediate and visible at deploy (non-zero exit, PM2 restart loop), not a hidden partial outage. The cost: with a bad key, the public surfaces (webhooks, catalogue, `/health`) are down too. `src1/scripts/*.ts` and `src1/db` also need the key.
- **Order.** `config.ts` loads `.env` (line 6) before building `CONFIG`. `src1/index.ts:7` imports config before the DB, routes and queue consumers. This ordering is statically observed only, not runtime-verified.

## Amendment

Add a top-level synchronous `requireJwtSecret(value: string | undefined): string` above `CONFIG`, and use `JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY)`.

- **Reject** `undefined`, a value whose `value.trim()` is empty, and exactly `your-secret-key` or `your-secret-key-change-in-production` after trimming.
- **On rejection,** throw `new Error('JWT_SECRET_KEY must be set to a non-placeholder value')`. The message is fixed and never echoes the value.
- **On acceptance,** return the raw value unchanged, so existing signatures are preserved.
- **Scope.** No fallback and no `NODE_ENV` condition. Consumers, `ISettings`, `.env.example`, dependencies, scripts and the start command are untouched.

No strength policy is introduced. Minimum length, entropy, format and rotation are security-owner decisions.

## Operator preconditions and C2

Startup behaviour changes. Any environment without a real key refuses to start, including local copies of `.env.example`.

- **Before deploying,** the operator must set a non-placeholder key.
- **Existing tokens.** If production signs with the fallback or the placeholder, a real key invalidates every existing token, so all users must log in again. It also stops tokens forged under the public value from verifying.
- **Owner decision.** Choosing or rotating the key, and the broader R06 session revocation, are owner/security decisions. No key value appears in evidence.

**C2 determination.** C2 does not gate this source edit. Its gate covers root dependency, lockfile, build/start and runtime-pin edits (`M0_START_APPROVAL_STATUS.md:39-45`, `C2_COMPATIBILITY_REVIEW.md:3,30`), and this slice changes none of them.

C2's outstanding baseline facts do gate activation. The owner reports `pm2 start server`, but the tracked `server.js` imports a non-existent `./src/...` tree. Whether the deployed process loads `src1/config`, and which revision is deployed, are therefore unknown. Deployment needs separate owner permission.

## Source-data verification plan

The check is `output/qa/jwt-secret/source-check.py` (stdlib, `-I`, sanitized environment), with receipts in `source-verification.json` (argv, cwd, exit codes, stdout/stderr, hashes). It reads TypeScript as text.

**Named semantic checks.** These run before the exact-candidate comparison:
- `NO_LITERAL_FALLBACK`: no `||`/`??` on the key; placeholders appear only in the rejection list.
- `VALIDATED_AT_LOAD`: the initializer calls the validator, which is declared above `CONFIG`.
- `UNCONDITIONAL`: no `NODE_ENV` guard.
- `GUARD_SYNCHRONOUS`.
- `PRESENCE_CHECK`.
- `PLACEHOLDER_SET_EXACT`.
- `NO_STRENGTH_POLICY`: no length, regex or entropy test.
- `THROWS_NOT_WARNS`.
- `FIXED_MESSAGE`.
- `RAW_VALUE_RETURNED`.
- `CLOSED_VOCABULARY`.
- `SINGLE_SECRET_SOURCE`: consumers are byte-pinned, and nothing else reads `process.env.JWT_SECRET_KEY`.

A decision model is run over these inputs: unset, `''`, whitespace, both placeholders, a padded placeholder and a synthetic valid value.

**Required results.** The `9ea963f` baseline is rejected, the amendment is accepted, and pins, `src1` diff scope and `git diff --check` all pass. Each negative control below must be rejected; the receipt records its `intended` check (which must be among its failures) and its `rejected_by` check:
- fallback reintroduced (`||`, `??`);
- validation gated to production;
- each placeholder omitted;
- whitespace accepted;
- trimmed value returned;
- warning logged instead of throwing;
- value echoed in the message;
- a length policy added;
- validation moved to first use;
- async validator;
- direct `process.env` read in a consumer.

## Runtime fixtures deferred until full C3 admission

Run in a sanitized child with no `.env`:
- An unset, empty, whitespace or placeholder key exits non-zero before listen, DB connect or queue load, with no secret logged.
- A synthetic valid key starts normally.
- A token signed with the old fallback gets 401 `INVALID_TOKEN`.
- Reintroducing the fallback fails the regression.

## Source hashes at `9ea963f`

| File | SHA-256 |
| --- | --- |
| `src1/config/config.ts` | `0fcb0df49527c155083d2f3e4c81b36650bab14e207b5635a0831b2827d884e1` |
| `middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `auth/services/index.ts` | `58323c9324411ab48e69d06e4e84ed76e9e01690a9200ac416a937d9a6836390` |
| `settings/services/index.ts` | `aebc4544bb1283a11d4063f020651111d950b218772f3c2783b5ca357ffe7558` |
| `.env.example` | `218b357a6e2a0f3c6de35174908b8bf594dbe8cc7753625db16dfa76cd60b725` |
