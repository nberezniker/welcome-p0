# ADR 0006 — AUTH_DEV_EXPOSE_OTP semantics + production auth adapter plan

Status: accepted. Context: OTP delivery needs a provider (email/SMS) that P0
does not have; development still needs a scriptable login path.

Decision: `AUTH_DEV_EXPOSE_OTP=true` (development only) returns the OTP code in
the request response as `devCode`; otherwise the code is written to the
gitignored `.runtime/otp.log` for manual testing. The flag is read per request
(`devExposeOtp()`), never baked into the build; integration tests enable it and
assert the response shape. The response body shape is identical either way
(`ok:true`) — no enumeration difference.

Production plan: the flag must be absent (fail closed); a real auth adapter
(email provider) replaces the log/file path behind the same route contract.
The build/start gate treats enabled dev flags as a release blocker
(SECURITY_TESTS #17). Until then production builds with the flag set are
rejected by configuration checks, not by convention.
