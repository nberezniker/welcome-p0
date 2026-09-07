# Preflight и AutoClaw adapter

## Scope
Сверить capabilities установленного AutoClaw, target Git/worktree, source hashes и лимиты; не заменить maker Antigravity незаметно. Реализовать отдельный AutoClaw execution contract или честный BLOCKED.

## Acceptance
Контрольная плохая правка отвергается gates; пустой/двойной verdict отвергается; reviewed SHA/diff hashes проверяются; secrets не выводятся.

Связанные проверки: AC-01 AC-02 AC-03.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.
