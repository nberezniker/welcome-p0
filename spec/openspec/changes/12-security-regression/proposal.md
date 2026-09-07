# Security / нагрузка / regression

## Scope
Secret scan, dependency audit, prompt injection/XSS/SSRF/CSRF/IDOR, load test, backup restore и полная acceptance matrix.

## Acceptance
Ноль unresolved critical/high; по targets отчёт measured/failed; независимое review exact SHA с test evidence.

Связанные проверки: AC-51 AC-52 AC-53 AC-54.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.
