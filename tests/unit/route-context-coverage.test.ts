import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static gate (unit): every API route handler runs inside a request scope.
 *
 * WHY THIS EXISTS. `correlation_id` is only worth having if the guarantee is
 * TOTAL: a user reports the id from an error body, and the operator greps the
 * logs for it. That works because the id is ambient for the duration of the
 * request (src/lib/request-context.ts) — and an id is ambient only if something
 * ESTABLISHES it. Before this gate, the establishing wrapper (`withApi`) covered
 * the 47 mutating/sensitive routes and 19 read-only GETs bypassed it entirely,
 * so on those routes an error body carried a freshly minted id that appeared in
 * no log line at all: exactly the "correlation id exists in places" the review
 * called out.
 *
 * A convention would not hold: the 20th route added after this commit would
 * silently reopen the hole, and nothing would fail. This file is the reason it
 * cannot — the same class-guard shape as tests/unit/client-boundary.test.ts and
 * tests/unit/static-safety.test.ts.
 *
 * WHAT IT ASSERTS (per file, per exported method):
 *   - a route that exports an HTTP method must export it as a WRAPPED const
 *     (`export const GET = withApi(…)` / `withRequestContext(…)`);
 *   - a bare `export async function GET` is a finding.
 *
 * withApi is a superset of withRequestContext (guards + scope), and which one a
 * route uses is a product decision this gate deliberately does not make: a
 * read-only GET must NOT silently acquire a rate limit or a CSRF check.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_DIR = 'src/app/api';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...routeFiles(rel));
    else if (entry.name === 'route.ts') out.push(rel);
  }
  return out;
}

const FILES = routeFiles(API_DIR);

test('route context: the scan actually sees the API surface', () => {
  // A glob that silently matched nothing would make every assertion below
  // vacuous. The number is a floor, not an equality: adding routes is normal.
  assert.ok(FILES.length >= 60, `expected the API routes to be enumerated, found ${FILES.length}`);
});

test('route context: every exported handler is wrapped in a request scope', () => {
  const findings: string[] = [];

  for (const file of FILES) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const method of METHODS) {
      const bareExport = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`);
      const wrappedExport = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*with(?:Api|RequestContext)\\s*[<(]`);
      if (wrappedExport.test(text)) continue;
      if (bareExport.test(text)) {
        findings.push(`${file}: ${method} is exported directly — wrap it in withApi/withRequestContext`);
      }
    }
  }

  assert.deepEqual(findings, [], 'a handler outside a request scope has no correlation id in its logs');
});
