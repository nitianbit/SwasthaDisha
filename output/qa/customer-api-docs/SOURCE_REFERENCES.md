# Customer API schema OTP documentation correction

12 November 2026. Source-reference cleanup only; author `/root/customer_booking_writer`. Root owns Git. Writes stop after this note.

The sole existing API_SCHEMAS.md is at repository root; `rg --files` found none under documentation. The root file contained two explicit obsolete claims, not illustrative examples: `Default OTP: 123456` in the verification field description and `Default OTP for testing: 123456` in Notes. Both were replaced. Six-digit schema validation remains unchanged, and no other API/schema/authentication claims were amended or revalidated.

Changed document: [API_SCHEMAS.md](../../../API_SCHEMAS.md).
Before SHA-256: `e756a47d787f8548ba1d12296bbde88ba0ad959892d90fb106fa8bf3ea7deb95`.
After SHA-256: `071c133ad9fc86cc561b18fb944d1a66b8ed5a10cfda2a4948e67d3da4a658b9`.

The description now directs readers to the generated code. Notes describe observed source: random login code generation, account/current-destination binding, stored-expiry checks and conditional consumption through one database update. No expiry duration, resend/attempt/rate-limit, delivery, deployed runtime, supported-client or release guarantee was added. A randomly generated value can equal a numerical example; no value is documented as a fixed/default bypass.

Exact durable source was read directly because the graph query returned no matching symbols and the graph indexes an older checkout. Source references and SHA-256 values:

| Source | Lines | Observed implementation | SHA-256 |
| --- | --- | --- | --- |
| [src1/modules/auth/services/index.ts](../../../src1/modules/auth/services/index.ts) | 99–101, 203–211, 322–340 | Login generates a random six-digit code, records selected account/target/destination, and verifies against that account’s current destination. | `d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56` |
| [src1/modules/auth/validation/index.ts](../../../src1/modules/auth/validation/index.ts) | 33–43 | Request OTP is a required string matching six decimal digits. | `c0424a7bf6fb49226dec0aa39babec98221f50fcd842c4137120b8a30a3d3527` |
| [src1/modules/otp/services/index.ts](../../../src1/modules/otp/services/index.ts) | 39–126 | Exact-code lookup; verified/expiry/destination checks; conditional consumption result required. | `cf59555cb618ace73e78e7fb35ca5ce780075ed30d5c3f7c633b1777b4b07971` |
| [src1/modules/otp/repository/index.ts](../../../src1/modules/otp/repository/index.ts) | 42–60 | Conditional update matches challenge/account/code/target/destination, unverified state, observed expiry and consumption time. | `8d59e92cb0d019a2d777d9b794278f126714205dce774caee5cd6e96d14a6841` |
| [src1/modules/common/repository/BaseRepository.ts](../../../src1/modules/common/repository/BaseRepository.ts) | 65–71 | Repository update uses model.findOneAndUpdate(query, data, options).lean(). | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| [src1/modules/otp/model/index.ts](../../../src1/modules/otp/model/index.ts) | 4–35 | Stored challenge fields include account, code, target/destination, expiry and verified state. | `9891e0b34bbd3b21502540d86a8001c4f666223ddb8628c2922a1953ede6506d` |

Observed bounded verification: the stdlib Python edit checked the exact before hash and uniqueness of both original claims, performed only those two substitutions, confirmed no remaining `Default OTP` or `123456` text in this document, resolved all four newly added source links, and confirmed all 358 existing src1 files retained their bytes across the documentation edit. The displayed Git diff contains exactly the two expected line replacements. `git diff --check -- API_SCHEMAS.md` exited 0 with empty stdout/stderr. Every source hash above was rechecked while creating this note. No test harness was created.

The initial guessed documentation/planning/API_SCHEMAS.md read returned file-not-found before any write; discovery then located the root file. No check or runtime success is inferred from that read. No application source changes or application/source execution, parser/compiler, tests, packages, Node, Docker, DB, provider, network or Git mutation occurred. Existing authentication, deployment, privacy and focused-runtime gates remain separate. This corrects the documentation only.
