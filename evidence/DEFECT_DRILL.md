# Defect drill — controlled defect injection (Phase 5, item 9)

- Date: 2026-09-07T21:03:50.850Z
- Commit: 24784dacf096b363b7121aba888e664cb2b19428
- Injected defect: `src/lib/public-profile.ts` — `loadPublicProfile` contact query changed from
  `public_enabled = true` to `public_enabled IN (true, false)` (regex replace on disk,
  marked `DEFECT-DRILL-INJECTION`), so PRIVATE contact values leak into the public
  projection.
- Guard test: `public API returns ONLY the public projection`
  (`tests/integration/profile.test.ts`, run via `--test-name-pattern`)
- Exit codes: with defect = 1 (FAIL, expected); after revert = 0 (PASS, expected)
- Logs: `evidence/defect-drill-fail.log`, `evidence/defect-drill-pass.log`
- Residue check: `git status --porcelain --untracked-files=no` empty and
  `git diff --stat` empty after the drill — the tree is identical to the pre-drill state.
- Conclusion: the public-projection gate FAILS on the injected leak and PASSES on the
  clean tree — the gate is protective.
