# Preflight и AutoClaw adapter

- [ ] Прочитать контракты и зафиксировать dependencies/allowed paths для этого change.
- [ ] Сверить capabilities установленного AutoClaw, target Git/worktree, source hashes и лимиты; не заменить maker Antigravity незаметно. Реализовать отдельный AutoClaw execution contract или честный BLOCKED.
- [ ] Проверить: Контрольная плохая правка отвергается gates; пустой/двойной verdict отвергается; reviewed SHA/diff hashes проверяются; secrets не выводятся.
- [ ] Независимый review, evidence и commit; закрыть AC-01 AC-02 AC-03 только по результатам.
