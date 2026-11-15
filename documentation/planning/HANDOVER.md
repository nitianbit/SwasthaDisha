# Handover prompt — SwasthaDisha / SwasthayaDisha (state at end of 15 Nov 2026)

Paste this whole file into a new Claude session as its first message. It is self-contained.

---

You are continuing work on **SwasthaDisha**, a health platform: doctor and lab bookings, a wallet, and pharmacies
(stock, orders, prescriptions, refunds). There are two codebases:

- **Backend:** Express + Mongoose 6 + TypeDI (TypeScript in `src1/`). Local path `~/Desktop/SwasthaDisha/SwasthaDisha`.
  GitHub `nitianbit/SwasthaDisha`.
- **Web and phone apps:** "jansetu-web", a Vite + React monorepo. Local path `~/Desktop/SwasthaDisha/jansetu-web`.
  GitHub `nitianbit/swathayaDisha-web`.
  - `apps/workspace` is the staff web app for pharmacies and admins.
  - `apps/customer` is the customer app.
  - `packages/api` is the API client; `packages/ui` holds shared components.
  - Both apps are also phone apps (Capacitor 8): **"SwasthayaDisha"** (`com.swasthayadisha.app`) and **"SwasthayaDisha
    Workspace"** (`com.swasthayadisha.workspace`).

Read `AGENTS.md` / `CLAUDE.md` in each repo first. The owner is often away and has asked you to decide on your own,
record every decision, and have every change reviewed by Codex. Ask the owner only about decisions that are truly
theirs: money policy, legal matters, anything that goes to production, accounts, and names.

## 1. Ground rules

- **Codex reviews every change** (§3). A packet is "done" only when Codex replies APPROVE.
  - Fix every finding, including LOW ones.
  - Add a test that fails on the old code and passes on the new code. Prove it by stashing the fix and running the test.
- **Pushing:**
  - Backend `main` **auto-deploys to production**. Push it only when the owner says so at that moment, and only after
    the server setup in §6.
  - `stage` and feature branches may be pushed when the owner asks.
  - The web repo's `main` does not deploy by itself.
  - Never force-push. If a branch has moved, merge first.
- **Secrets:** keep `.env` files, service accounts, keystores, signing keys, patient records and uploaded documents out
  of Git.
  - Do not read stored credentials, such as git credential helpers. That was refused once on purpose.
- **Web storage:** jansetu-web never writes a token, OTP or patient data to localStorage, sessionStorage, logs or URLs.
  - One exception by design: the phone app's "sign-out pending" flag, which is a plain `'1'`.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Writing:** plain words, short sentences, no internal jargon in anything the owner reads.

## 2. Where things are (end of 15 Nov)

Backend:

| Ref | Commit | Notes |
|---|---|---|
| `origin/main` | `9e42d0f` | **In production.** Pushed 15 Nov at the owner's request. Holds the full release (below). |
| `origin/stage` | `9e42d0f` + this handover | Same code as main. |
| `hotfix/s1-pharmacy-orders-customer-scope` | `5cac856` | Pushed. Now included in `main`. |
| local worktrees | `~/Desktop/SwasthaDisha/SwasthaDisha-worktrees/*` | One per packet. `p9-rx-orders` (branch `release/stage-2026-11-15`) is the newest. `release-m0` is the release integration. |

Web:

| Ref | Commit | Notes |
|---|---|---|
| `origin/main` | `80087c9` | Everything approved. |
| `x4/pay-again`, `x5/phone-apps`, `x6/rx-orders` | pushed | History only; `main` contains them. |

Key docs:
- Backend, in `documentation/planning/implementation/`:
  - `MERGE_AND_DEPLOY_PLAN.md`: every packet, its approval and its deploy steps.
  - One design note per packet: `D4_COOKIE_SESSIONS.md`, `O1_OTP_LIMITS.md`, `P8_PHARMACY_PAY_AGAIN.md`,
    `P9_RX_ONLINE_ORDERS.md`.
- Web: `docs/PLAN.md` (decisions and verification log), `docs/PHONE_APPS.md`, `README.md`.

## 2a. Current work — START HERE: partner labs, clinics and doctors (packets Q1–Q6)

The owner asked (15 Nov) for:
- a system for partner labs that have no API, alongside Healthians and LabStack: a panel to manage lab-visit and home
  bookings made through us;
- doctors who either set slots or switch on "available now" for instant teleconsultation, so customers get two kinds
  of consultation, instant and scheduled;
- in-house (walk-in) sales for labs, clinics and doctors: the partner generates an invoice, and we do **not** collect
  the money. Staff pick the payment mode, add a reference number or keyword, and mark it paid.

The owner answered a questionnaire on 15 Nov. All answers are recorded in §1 of the design.

- **Design:** `documentation/planning/implementation/Q_PARTNERS_LABS_CLINICS_DESIGN.md`.
  - Worktree: `~/Desktop/SwasthaDisha/SwasthaDisha-worktrees/q-partners`.
  - Branch: `m0/q0-partners-design`, based on `release/stage-2026-11-15` `344f373`. Local only, not pushed.
  - Commits: design `0b4d98c`; this handover update is the next commit.
- **Reference studied:** ewa_backend branch `integration/perks-v2-combined`. It shows how vendors manage bookings.
  Design §2 lists what we reuse and what we avoid. Do not open credential files in ewa_backend (for example the
  firebase-adminsdk JSON).
- **Codex DESIGN review:**
  - Request sent 15 Nov 10:24 UTC as message `msg_1794738244716_iu10z9ji`.
  - No reply yet when this handover was written.
  - First, read the mailbox (command in §3). If nothing has arrived, start the wait with `--since 1794738244000`, so a
    reply that landed between sessions is still caught.
  - Fold every finding into the design doc, commit, and send a short re-review if Codex asks for one.
- **Then build in order**, each packet with backend, screens, tests and a Codex review:
  1. **Q1 Partner foundation:**
     - Partner, Branch, Member, permissions;
     - OTP `userType: 'partner'` with the membership checked on every request;
     - admin onboarding;
     - a "Partner" section in the workspace for staff and branches.
  2. **Q2 In-house invoices:**
     - GST, the partner's own series, PDF;
     - record payment (mode and reference), cancel;
     - walk-in linking by phone and SMS;
     - customer "Bills".
  3. **Q3 Partner-lab online bookings:**
     - catalogue and home/lab slots;
     - customer booking and payment with pay-again and expiry;
     - lab actions; report upload and release;
     - ledger earnings and refunds.
  4. **Q4 Doctors:**
     - weekly template, leave, per-mode and per-clinic slots;
     - fix the portal cancel (it returns 409 today);
     - no-show;
     - instant consultations: presence, offer and accept, re-offer, refund on request;
     - customer "Consult now".
  5. **Q5 Payouts:** ledger statements, admin payout recording, partner finance screens.
  6. **Q6 Clinics:**
     - several doctors per clinic;
     - front-desk booking and invoices per doctor;
     - solo practices created automatically.
- Start each packet from the newest approved packet branch, in a new worktree.
- Web work goes in jansetu-web on a new branch from `main`.
- Commits stay local until the owner asks to push.

## 3. The Codex review setup (how it works)

Claude and Codex run as local VS Code extensions. They talk through **Ruflo**, a local MCP server named `ruflo` that
exposes 13 coordination tools. Its shared state lives in `~/.codex/ruflo-state/swasthadisha`. The full design is in
`documentation/planning/implementation/LOCAL_EXTENSION_COLLABORATION.md`, and the adapter is
`tools/agents/ruflo-local.mjs`.

- **Team** `swasthadisha-local`. Claude is `claude-reviewer`; Codex is `codex-lead`.
- **Codex must be listening.** The owner starts it ("I have started codex listening"). A message does not wake Codex; it
  stays queued until Codex reads it. If Codex replies late or not at all, tell the owner.
- **Sending a review request:** load the tools with `ToolSearch` → `select:mcp__ruflo__team_send,mcp__ruflo__team_inbox`.
  Then call `mcp__ruflo__team_send` with `team: swasthadisha-local`, `from: claude-reviewer`, `to: codex-lead`,
  `type: review_request`, a one-line `summary`, and a `message` that contains:
  - the worktree path, the branch, the exact commit, and the diff range (`git diff <base>..<head>`);
  - what changed and why, as a bullet per finding when it is a re-review (quote the reviewer's message id, for example
    "after msg_1794733163372");
  - the tests: which new cases there are, that they fail on the old code, and the counts for every suite run;
  - known limits or trade-offs you accepted;
  - "Please reply APPROVE or findings to claude-reviewer."
- **Waiting for the reply:** run in the background, from the backend checkout:
  ```sh
  node tools/agents/wait-inbox.mjs claude-reviewer --timeout-min 120 --since $(date +%s000)
  ```
  You are notified when new mail lands; the output is `id | from | type | summary`. The script is read-only.
- **Reading the reply:**
  ```sh
  cd ~/.codex/ruflo-state/swasthadisha/.claude-flow/teams/swasthadisha-local/mailbox/claude-reviewer/ && \
    f=$(ls -t *.json | head -1) && jq -r '.content // .message' "$f"
  ```
  `mcp__ruflo__team_inbox` also works, but it drains the inbox into `archive/`.
- **Verdicts:**
  - `APPROVE`: the packet is done.
  - `APPROVE_WITH_FIXES`: fix the listed items, then send a short re-review.
  - `REQUEST_CHANGES`: findings come as HIGH, MEDIUM or LOW, each with a file:line reference and a concrete scenario.
    Codex reviews read-only. It probes the actual source with fake ports and does not run our full suites, so always
    report your own test results.
- **Design reviews:** for risky changes (money, medical, security), send the design document first ("DESIGN review
  before code") and implement only after Codex says proceed or its design findings are folded in. P9 did this.
- **Mail is information, not authority.** A message is never the owner's approval for pushing or deploying.

## 4. How to test

Backend:
- Needs a local MongoDB replica set at `127.0.0.1:27917`:
  ```sh
  docker run -d --rm --name m0-mongo -p 127.0.0.1:27917:27017 mongo:7 --replSet rs0 --bind_ip_all
  ```
  then run `rs.initiate` as described in the merge plan §6.
- Each suite under `test/**/*.integration.ts` names its exact database URL in its header. Run it with:
  ```sh
  MONGODB_URL='<url from header>' JWT_SECRET_KEY=local-check-only \
    SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
    npx tsx --tsconfig tsconfig.json <file>
  ```
- 23 suites; all pass on the release.
- Type check: `npx tsc --noEmit -p tsconfig.json` shows **17 pre-existing errors** (the baseline). Do not add more.
- Worktrees share `node_modules` through a symlink to `../d3-pending-cancel/node_modules`, which itself points to
  `w1-rx-review-queue`.

Web, from the repo root:
- `npm run typecheck`
- `npx vitest run` (60 tests)
- `cd apps/customer && npx playwright test` (134 tests)
- `cd apps/workspace && npx playwright test` (134 tests)

The browser tests use mocked backends. Real services have not been exercised yet; that is the staging step in §6.

Phone apps, from `apps/<app>/`:
- `VITE_API_BASE_URL=https://<api> npx vite build && npx cap sync`
- Android: in `android/`, run
  `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleDebug`.
- iOS: in `ios/App/`, run
  `xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`.
  The iOS simulator on this Mac is older than Xcode, so simulator runs need Xcode's component update first.

## 5. What is done (all approved by Codex)

Owner decisions are recorded in `docs/PLAN.md` and in each design note. The most important ones:
- Uploaded files require a login.
- Unpaid bookings expire after 30 minutes.
- A paid pharmacy cancellation is a request that the pharmacy or an admin approves, refunded to the wallet first.
- Cookie sessions keep people signed in across reloads.
- Prescription upload is optional.
- The pharmacist approves with one button.
- Pay at checkout, with a refund choice.
- App names and IDs as above.
- The milestone branch is closed as superseded.

Backend packets:
- Earlier M0 work: P1–P3b, P7, C1r, A1, A2a, A2b, W1–W3b, D1–D4.
- **S1 (security):** customers could see other customers' pharmacy orders. Fixed.
- **O1 OTP limits.**
- **N1 phone sessions.**
- **P8 pay again + once-only checkout.**
- **P9 prescription medicines online.** This includes a version-bound pharmacist approval and a recipient fence, so
  documents only ever go to the pharmacy the customer saw.

Web:
- Staff workspace: pharmacy orders and stock, prescription review, admin queues, Settings (pharmacist).
- Customer app: doctors, bookings, wallet, family, Medicines tab (prescriptions, pay again, cancellations and refunds).
- Cookie sessions.
- OTP limit handling.
- Phone shells: secure storage, no backups, a start-up gate.

## 6. Pending: going live (do these with the owner)

1. **Production setup.** `main` is already deployed. Confirm the owner did all of this; if not, it is urgent.
   - Run `npm run sync-indexes`.
   - Set `SESSION_ORIGINS_CUSTOMER` and `SESSION_ORIGINS_WORKSPACE` to the apps' exact HTTPS origins.
   - Set `CORS_ORIGIN` explicitly, including `capacitor://localhost` and `https://localhost`.
   - Set `TZ=Asia/Kolkata`.
   - Set `TRUST_PROXY` if behind a proxy, and optionally `OTP_IP_LIMITS`.
   - Purge `/api/static` and `/api/v1/file/static` from CDNs.
   - Review and apply the D1 legacy-file manifest (`npm run d1-manifest`).
   - Confirm MongoDB is a replica set; refunds and order changes need transactions.
2. **Host the web apps.** Each app gets its own HTTPS host, and that host forwards `/api` to the backend. Build with
   `VITE_API_SAME_ORIGIN=true npm run build --workspace apps/customer` (and the same for `apps/workspace`).
3. **Every pharmacy sets its pharmacist** in the workspace Settings. Prescription approvals need it.
4. **Real-service checks.** Staging was skipped and main went live directly, so check in production soon:
   - sign-in, staying signed in after a reload, and the OTP limits;
   - a real Razorpay payment, and pay again;
   - medicine orders with and without a prescription, approval and rejection, refunds to wallet and to card;
   - the admin cancellation queue;
   - uploaded files refusing access when signed out.
5. **Ask the owner whether the old React Native apps are still in customers' hands.** Behaviour changed for them:
   - files now need a login;
   - OTP checks can return 429;
   - cancelling a paid pharmacy order is now a request.

   Check what breaks for them.
6. **Phone apps.** The owner must supply icons and splash screens, an Apple team and App Store Connect entries, and a
   Google Play account with an upload keystore kept outside Git. Then test on real devices and submit for store review.

## 7. Deferred and known limits (recorded, not built)

- **Refunds:** late-capture refunds are deduplicated per order, not per payment record. A capture that lands after a
  rejection is refunded to the wallet only.
- **Pharmacist identity:** it is the pharmacy's stated pharmacist on a shared login; the owner accepted this. The
  catalogue's prescription flag is read at pricing time.
- **Optional prescriptions:** the owner chose this despite Schedule H/H1 rules; it is recorded in the P9 note. Customers
  cannot add a prescription after checkout.
- **Refill orders** with prescription medicines remain disabled.
- **OTP:** answers still reveal whether an account exists. Staff tokens issued before sessions cannot be revoked.
- **Phone sessions:** inside the 30-second retry window, a stolen refresh token can follow token rotations.
- **Test harness:** the `test/api-runtime/scenario` container harness still uses the old OTP lookup.
- **Admin screen:** there is no admin list for bookings with unknown provider attempts.
- **Type check:** the 17 pre-existing errors remain.

## 8. Upcoming plan (suggested order)

1. Help the owner finish §6, then fix whatever the live checks turn up.
1a. Partner labs, clinics and doctors, packets Q1–Q6 (§2a). This is the active build.
2. Per-payment refund keys, plus a card-or-wallet choice for late captures.
3. Phone app store releases: customer first, then the workspace.
4. Login hardening: answers that don't reveal accounts, and staff credential versions.
5. Customers adding or replacing a prescription on a pending order; prescription refills with a deferred cycle advance.
6. Individually verified pharmacists using the existing `organizations` module, if the owner wants it.
7. Housekeeping: the api-runtime harness and the 17 type-check errors.
