# O1 — OTP attempt and send limits (2026-11-15)

Status: revised after Codex review msg_1794723005981 (counters per destination, not per caller). Built on `m0/o1-otp-limits` (on `m0/d4-cookie-sessions`). Decided by Claude while the owner was away
("take all decisions"); reviewed by Codex.

## Problem

A 6-digit login code was valid for 10 minutes with no limit on wrong guesses (a wrong code was a cheap `404`), so it
could be guessed by brute force; codes were stored in plain text; and anyone could trigger unlimited SMS (cost, and
account rows: an unknown number creates a customer/pharmacy on send).

## What changes

**Per code** (`OTP` rows):
- The code is stored only as `otpHash` = HMAC-SHA256(key derived from the server secret, `userId|target|destination|code`).
  Bound to its user and destination: a row can never verify anyone else. Legacy plain-text rows (sent before the deploy,
  at most 10 minutes old) still verify, under the same attempt limit.
- `attempts`: every check atomically spends one attempt **before** comparing (`findOneAndUpdate` with
  `attempts < OTP_MAX_ATTEMPTS`), so parallel guesses cannot exceed the limit. Default 5. After that the code is burnt:
  `429 OTP_ATTEMPTS_EXCEEDED` "Too many incorrect codes. Please request a new code." (even for the right code).
- Only the destination's newest pending code (highest `_id`) is checked; sending a new code deletes the older pending
  ones. A wrong code keeps today's answer (`404 OTP_NOT_FOUND`) with "Incorrect code. N attempts left.".

**Per destination** (`otp_throttles`, fixed windows, atomic `$inc`, TTL; keys are HMACs, never a phone number/email).
One counter per phone number / email address, shared by every account, role and purpose (login, personal and
corporate email verification); a check is counted on the code's own stored destination, never on what the caller
typed (Codex review msg_1794723005981):
- Send: 1 per 30 s, 5 per hour, 10 per day (`OTP_SEND_PER_HOUR`, `OTP_SEND_PER_DAY`). Checked before anything else:
  no lookup, no sign-up row, no SMS. A send refused by the 30 s gap does not use up the hourly/daily allowance.
- Check: 10 per hour, 20 per day across all codes (`OTP_VERIFY_PER_HOUR`, `OTP_VERIFY_PER_DAY`). So with resends an
  attacker gets at most 20 guesses a day per account (1 in 45,000), not 5 per code.
- Refusals: `429 OTP_SEND_LIMIT` / `OTP_VERIFY_LIMIT`, `Retry-After` header and `retryAfter` in the body.
- The same limits apply to the personal and corporate email-verification codes (same OTP service).
- One signed-in account may also request at most 10 email-verification codes an hour / 20 a day, whatever the
  addresses (no spraying codes to many mailboxes).

**Per client address** (optional): `OTP_IP_LIMITS=true` adds 30 sends / 60 checks per hour per address on the public
login routes. Off by default: behind a proxy every client would share the proxy's address. Set `TRUST_PROXY` (e.g. `1`)
first so `req.ip` is the client.

## Decisions

- Fixed windows in MongoDB (not Redis, not in-memory): works across instances with what is already deployed.
- Keep `404 OTP_NOT_FOUND` for a wrong code (existing apps handle it); new codes are `429`.
- No CAPTCHA, no account lock-out beyond the windows (a lock-out would let anyone lock a customer out for a day; the
  windows only cost a wait).
- Accepted trade-off: because a destination has one shared budget, someone who triggers codes to a victim's number
  can use up that number's hourly/daily check budget. The victim then waits (at most a day); nobody signs in as them.
  Per-address limits (`OTP_IP_LIMITS`) reduce it.
- Account enumeration on send/verify (`ADMIN_NOT_FOUND`, `USER_NOT_FOUND`) is unchanged; recorded follow-up.

## Not changed / follow-ups

- `test/api-runtime/scenario` (the admitted container harness) encodes the old lookup-by-code (it intercepts the
  `findOne` filtered by `otp`, and counts OTP writes); it must be updated to the per-destination lookup before it runs
  on this branch.
- Enumeration-safe send/verify answers.

## Tests

`test/otp-limits/o1-otp-limits.integration.ts` (14): hashed storage; 5 wrong codes burn the code; 40 parallel guesses
spend at most 5 attempts and never sign in; per-destination check limit across codes; newest code only; send gap and
hourly limit with `Retry-After`, no SMS, no account for a refused unknown number; HMAC'd TTL counters; legacy rows;
email verification limits; one budget per destination across accounts, roles and purposes; per-account send limit;
named vs omitted destination share one check budget; per-address limits off by default and working when on.
