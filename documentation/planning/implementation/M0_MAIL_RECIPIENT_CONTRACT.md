# M0 sensitive-mail recipient containment

10 November 2026. Baseline `5aecb5578869995063eabad5bc5a4c95c79f017b` in `nitianbit/SwasthaDisha`. This is a bounded source-only M0-B candidate under the [implementation scope](../M0_IMPLEMENTATION_APPROVAL.md), [AR-26](../SYSTEM_DESIGN.md#10-api-contract-and-compatibility) and Review-B PA-12 / TC-REV-012. It does not complete F03, F15 or M0.

## Actor, fields and compatibility

The actor is an existing internal caller of `EmailService.sendEmail`; this slice does not expose a new route or grant a caller additional recipient authority. Its existing `SendEmailPayload` has `to`, `subject`, `textBody`, optional `htmlBody` and optional `sender`. The implementation currently uses the configured sender rather than the optional payload sender; preserve that behavior.

| Boundary | Required behavior |
| --- | --- |
| Intended destination | Forward the existing caller's explicit `to` array without adding recipients |
| Secondary destinations | Remove the unconditional `cc` property; add no CC, BCC, payload spread or replacement secondary address |
| Authentication callers | Preserve the one normalized intended target supplied by `AuthService.sendOTP`, `sendEmailVerificationOTP` and `sendCorporateEmailVerificationOTP` |
| Booking/payment callers | Preserve their existing explicit recipient arrays, subject and content; this is not a new authorization of those arrays |
| Provider request | Preserve configured sender, endpoint, content mapping, authentication headers and request options |
| Result and failures | Preserve success/data result and the existing missing-key, missing-sender and provider-failure handling |

There is no request/response schema, actor, state, amount-unit, index, database, dependency or startup migration. The entire production amendment is deletion of one fixed-recipient property from `src1/modules/email/services/index.ts`. No client is entitled to receive an authentication copy through that implicit secondary destination. Relevant deployed client revisions remain unknown; no broader client compatibility claim follows.

## Source verification and execution boundary

Before editing production source, obtain independent internal technical review of this contract and the proposed one-property deletion. Review the final source and evidence directly afterward. Keep the six staged Ruflo files and the complete handover archive byte-identical; the owner has deferred connection work.

Permitted verification in this slice reads source as data only: compare the candidate with the baseline and require exactly one deleted `cc` line, verify the remaining provider envelope and complete surrounding file are byte-identical, and inventory the seven known internal call sites. A source-only negative control must reject the baseline with its added recipient. Record exact commands, source/evidence hashes, review identities and limits. Do not install a parser/compiler or run root build/start commands for this change.

Do not import/evaluate the email service, configuration, application, an extracted method or provider SDK. No email, network, DB or Docker operation is part of this source slice. Complete C3 admission must precede any future runtime fixture, including a fake-provider check of normal intended-target delivery, absent CC/BCC and provider failures. Static comparison cannot establish delivery or zero runtime provider effects.

TC-REV-012 remains `NOT_RUN`; its later admitted runtime fixture must capture the exact outbound envelope for authentication and booking callers, require only the intended recipients, preserve content/error behavior, and fail with the original secondary-recipient defect reintroduced. Keep the selected 115-scenario outcome totals unchanged. Prior-recipient exposure assessment belongs to the security/account owner; no incident or remediation of historical messages is established here.

## Remaining gates

The [M0-A progress record](M0_A_PROGRESS.md), [C2 retained-server facts](DEVOPS_BASELINE_REQUEST.md), [C3 application contract](C3_APP_ISOLATION_CONTRACT.md), raw public OTP and fixed-code bypass findings, other route/field containment contracts, named security/clinical/finance owners, M0 acceptance and release gates remain open. The existing application diagnostic is historically `BLOCKED_BEFORE_LAUNCH`, separate from the first executed smoke failure; no retry is included.
