# Подбор знакомств

## Scope
Реализовать server-side eligibility и формулу из architecture; top≤3, facts-based reasons, deterministic tie-break, normal empty state.

## Acceptance
No self/blocked/no mutual/no duplicate; порядок стабилен; нужны актуальные разрешённые данные; LLM не требуется для ядра.

Связанные проверки: AC-27 AC-28 AC-29 AC-30.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.
