# JWT secret fail-closed contract

10 November 2026. Branch `m0/authority-jwt-secret`, baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`. **Pre-reviewed: APPROVE WITH REQUIRED AMENDMENTS** (internal Claude nonauthor Spec review of `e82c31c`; amendments applied below). This is not a named-owner approval. Addresses the secret half of R06 (`documentation/planning/REPOSITORY_REVIEW.md:57`). Production scope: `src1/config/config.ts` only.

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
- **Order.** `config.ts` loads `.env` (line 6) before building `CONFIG`. `src1/index.ts:7` imports config as its first application import, ahead of the DB, routes and queue consumers. This ordering is statically observed only, not runtime-verified.
- **Order is checked and pinned.** `DOTENV_BEFORE_VALIDATION` protects the call position: the environment is read by the `CONFIG` initializer (`config.ts:36`), and a call placed above `dotenv.config` would reject a correctly configured `.env`. Moving only the declaration is runtime-equivalent, because function declarations hoist; keeping the declaration after `dotenv.config` is a stated style pin (`DECLARATION_ORDER_STYLE`). `src1/index.ts` is byte-pinned.
- **Precedence (not verified locally).** dotenv does not override a variable already present in the process environment, even an empty one such as a blank PM2 env entry. A valid `.env` key can therefore be shadowed, and the process then refuses to start. That is fail-safe.
- **Blast radius.** 25 `src1` modules import config. Every entry point now needs the key:
  - `src1/index.ts` (`dev`);
  - `npm run sync-indexes`;
  - `migrate:pharmacy-inventory-batches`;
  - `test:pharmacy` (`test/pharmacy.integration.test.ts:9-40`). This suite used to skip when `PHARMACY_TEST_MONGODB_URI` was unset (`:44-45`); without a key it now fails at import, before that decision is reached.
- **Future app-import admission.** The F01 harness environment allowlist (`test/application/bootstrap.mjs:6-9`) has no `JWT_SECRET_KEY`. Any future C3/F01 app-import admission must add a synthetic, non-placeholder key, never a real one. That change belongs to the admission, not to this slice.

## Amendment

Add a top-level synchronous `requireJwtSecret(value: string | undefined): string` above `CONFIG`, and use `JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY)`.

- **Reject** `undefined`, a value whose `value.trim()` is empty, and exactly `your-secret-key` or `your-secret-key-change-in-production` after trimming. The match is exact and case-sensitive, so case variants such as `Your-Secret-Key` are accepted.
- **On rejection,** throw `new Error('JWT_SECRET_KEY must be set to a non-placeholder value')`. The message is fixed and never echoes the value.
- **On acceptance,** return the raw value unchanged, so existing signatures are preserved.
- **Scope.** No fallback and no `NODE_ENV` condition. Consumers, `ISettings`, `.env.example`, dependencies, scripts and the start command are untouched.

No strength policy is introduced. Minimum length, entropy, format and rotation are security-owner decisions. A future owner strength policy must amend this frozen check, including `NON_PLACEHOLDER_ACCEPTED` and the `case_folded_placeholder_policy` control, rather than bypass it.

The exact text is frozen in the check:
- validator block SHA-256 `1e6ec2c4e0281e82820e45be775e332a0bd94fb9e54eb89014908627ce8adba8`;
- expected `config.ts` SHA-256 `e879b0f9c635283d7c9a271128605c6d8583995356e30f5f1c318d23270d09f6`.

**What passing proves.** It proves only that the key is present and is not one of the two literals. It does not prove the key is secret. `documentation/hipaa/HIPAA_BACKEND_CHANGES.txt:64` already advises rotating the JWT secret as exposed. Route containment depends on a genuinely secret key, which the owner and security must establish.

## Operator preconditions and C2

Startup behaviour changes. Any environment without a real key refuses to start, including local copies of `.env.example`.

- **Before deploying,** the operator must set a non-placeholder key through the process environment or `<cwd>/.env`. `.env` is resolved from `process.cwd()` (`config.ts:6`), and the PM2 working directory is still an open C2 fact (`M0_START_APPROVAL_STATUS.md:41`).
- **Unreachable `.env`.** A deployment whose key sits in a `.env` its cwd does not reach was already running on the public fallback. It will now refuse to start.
- **Existing tokens.** If production signs with the fallback or the placeholder, a real key invalidates every existing token, so all users must log in again. It also stops tokens forged under the public value from verifying.
- **Owner decision.** Choosing or rotating the key, and the broader R06 session revocation, are owner/security decisions. No key value appears in evidence.

**C2 determination.** C2 does not gate this source edit. Its gate covers root dependency, lockfile, build/start and runtime-pin edits (`M0_START_APPROVAL_STATUS.md:39-45`, `C2_COMPATIBILITY_REVIEW.md:3,30`), and this slice changes none of them.

C2's outstanding baseline facts do gate activation. The owner reports `pm2 start server`, but the tracked `server.js` imports a non-existent `./src/...` tree. Whether the deployed process loads `src1/config`, and which revision is deployed, are therefore unknown. The `server.js:9-16` imports (`./src/config/config.js`, `./src/db`, `./src/routes`) match a compiled `src1` layout. Also, `tsc` emits to `./dist` and leaves the `@/` aliases unresolved. Owner questions: what is the PM2 cwd, and is the deployed `./src` compiled `src1`? On that path, `server.js`'s own dotenv (`:16`) runs only after config has loaded. The key must therefore come from the process environment or `<cwd>/.env`. Until the owner confirms that the deployed process loads `src1/config`, neither this guard nor the users or wallet route containment protects the deployed service. Deployment needs separate owner permission.

## Source-data verification plan

The check is `output/qa/jwt-secret/source-check.py` (stdlib, `-I`, sanitized environment), with receipts in `source-verification.json` (argv, cwd, exit codes, stdout/stderr, hashes). It reads TypeScript as text. The named semantic checks are diagnostic and give each control a stated reason. The binding gate is `EXACT_TRANSFORM` plus `PROTECTED_PINS` plus `DIFF_SCOPE`:
- the pins cover every consumer, `src1/index.ts`, `src1/db`, both scripts, `test:pharmacy`, the harness bootstrap, `.env.example` and the root manifests;
- the diff scope covers the whole tree against `9ea963f` (`git diff --name-only` plus `git status --porcelain --untracked-files=all`). It must be a subset of `config.ts`, this contract, the check and the receipt, so a force-added root `.env` or a `server.js` edit fails;
- the candidate is compared as raw bytes (no newline normalisation), and the receipt reports its real byte hash;
- trimming is modelled with the explicit ECMAScript WhiteSpace and LineTerminator set, not Python `str.strip()`.

**Named semantic checks.** These run before the exact-candidate comparison:
- `NO_LITERAL_FALLBACK`: no `||`/`??` on the key; placeholders appear only in the rejection list.
- `VALIDATED_AT_LOAD`: the initializer calls the validator, which is declared above `CONFIG`.
- `UNCONDITIONAL`: no `NODE_ENV` guard.
- `DOTENV_BEFORE_VALIDATION` (call position).
- `DECLARATION_ORDER_STYLE` (style pin).
- `NO_TRY_CATCH`.
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

**Required results.** The `9ea963f` baseline is rejected, the amendment is accepted, and the pins, the whole-tree diff scope and `git diff --check` all pass. Each negative control below must be rejected; the receipt records its `intended` check (which must be among its failures) and its `rejected_by` check:
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
- validator wrapped in a load-time try/catch (`NO_TRY_CATCH`);
- validator declaration hoisted above `dotenv.config` (`DECLARATION_ORDER_STYLE`), or `dotenv.config` moved after `CONFIG` (`DOTENV_BEFORE_VALIDATION`);
- an invented extra placeholder;
- a non-placeholder key rejected, or a case-folded placeholder policy (`NON_PLACEHOLDER_ACCEPTED`);
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
