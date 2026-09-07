# Defect drill — controlled defect injection (Phase 5, item 9)

- Date: 2026-09-07T21:44:49.117Z
- Commit: 7605b005bc90f77b90d82a561a0b6e6bdcbe1f34
- Injected defect: `src/lib/public-profile.ts` — `loadPublicProfile` contact query changed from
  `public_enabled = true` to `public_enabled IN (true, false)` (regex replace on disk,
  marked `DEFECT-DRILL-INJECTION`), so PRIVATE contact values leak into the public
  projection.
- Guard test: `public API returns ONLY the public projection`
  (`tests/integration/profile.test.ts`, run via `--test-name-pattern`)
- Exit codes: with defect = 1 (FAIL, expected); after revert = 0 (PASS, expected)
- Logs: `evidence/defect-drill-fail.log`, `evidence/defect-drill-pass.log`
- Residue check: no tracked modification outside the drill's own evidence outputs
  (`evidence/defect-drill-fail.log`, `evidence/defect-drill-pass.log`, `evidence/DEFECT_DRILL.md`),
  i.e. the injected defect is fully reverted from `src/lib/public-profile.ts` and no other tracked
  file changed (checked via `git status --porcelain --untracked-files=no` and
  `git diff --name-only`).
- Conclusion: the public-projection gate FAILS on the injected leak and PASSES on the
  clean tree — the gate is protective.
