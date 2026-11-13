# Personal email verification follows the profile rule

Owner scope: an individual customer may fill a missing phone/email, but only an admin replaces an existing personal contact. The current personal email-verification send/verify methods otherwise allow a customer to replace their stored personal email, bypassing the profile rule. This small closure affects only those two methods in AuthService, not signup/login or the separate corporate-only methods.

- Reject a differing existing normalized personal email before issuing/sending a challenge. Return `422 EMAIL_CHANGE_ADMIN_ONLY`.
- On verify, bind the OTP request to the supplied email or the current stored email, if one exists. Reject a known mismatch before consuming the proof, and independently check the recorded proof destination afterward.
- Same-email verification and first addition/verification of a missing email remain positive supported operations. Input alone never supplies verification.
- The final update compares the exact raw observed email and requires its scalar/missing type. A concurrent admin/profile edit causes `409 CONTACT_CHANGED`, never an overwrite. The consumed OTP is not restored; ask for a new challenge after a conflict.
- Keep all signup/login code and corporate-only verification methods unchanged. Existing shared OTP purpose/session/index limitations are not solved or relabeled by this delta.

Root authors source and bounded recording-port checks. `/root/profile_owner` inspected actual AuthService and OTPService and issued independent Standards `APPROVE_IMPLEMENTATION_CONTRACT_ONLY`; `/root/booking_owner` supplies the separate Spec decision before edits. No runtime/application/DB/provider execution is admitted by this document.
