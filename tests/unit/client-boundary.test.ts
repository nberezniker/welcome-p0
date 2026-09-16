import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static gate (unit): the CLIENT BOUNDARY.
 *
 * Next replaces every export of a `'use client'` module with a client REFERENCE
 * in the server graph. A component reference is usable — React renders it — but
 * any other value is not the value at all: it is a proxy object. A server module
 * that imports DATA from a client module therefore holds a proxy, and the failure
 * appears at render time, not at build time.
 *
 * That is exactly how GET /me/privacy answered 500 for every signed-in user
 * (2026-09-16): src/app/me/privacy/page.tsx imported `CONSENT_PURPOSES_UI` from
 * the `'use client'` panel and called `.map` on it —
 *
 *   TypeError: {imported module ./src/app/me/privacy/privacy-panel.tsx}
 *              .CONSENT_PURPOSES_UI.map is not a function
 *
 * — while `pnpm typecheck`, `pnpm lint` and both the unit and the integration
 * suites stayed green, because a client boundary only exists once Next compiles
 * the real graph for a REQUEST. The list now lives in ./purposes.ts on the server
 * side, the e2e regression that renders the page is
 * tests/e2e/privacy-consents.spec.ts, and this file is the class guard that keeps
 * the next export off the wrong side of the boundary.
 *
 * The rule enforced here: a module that is NOT `'use client'` may import only
 * COMPONENTS from a module that IS. "Component" is a PascalCase identifier — the
 * only shape React can render across a boundary — so a named, default, namespace
 * or side-effect import of anything else is a finding. `import type` and
 * `{ type X }` are fine: types are erased before the boundary exists.
 */

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = listSourceFiles(SRC_DIR);
const CLIENT_MODULES = new Set(
  FILES.filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8'))).map((f) => path.resolve(f)),
);

/** The client module a relative specifier points at, or null when it is not one. */
function clientModuleAt(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')]) {
    if (CLIENT_MODULES.has(candidate)) return candidate;
  }
  return null;
}

/** React can only render a PascalCase identifier across a boundary. */
const isComponentName = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name);

function scanClientBoundary(): string[] {
  const findings: string[] = [];
  for (const file of FILES) {
    if (CLIENT_MODULES.has(path.resolve(file))) continue; // this IS a client module
    const source = readFileSync(file, 'utf8');
    const relTarget = (target: string) => path.relative(SRC_DIR, target).split(path.sep).join('/');
    const where = (line: string) => path.relative(SRC_DIR, file).split(path.sep).join('/') + `: ${line}`;

    const fromRe = /import\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = fromRe.exec(source))) {
      const [, isTypeOnly, clause, spec] = match;
      const target = clientModuleAt(file, spec!);
      if (!target || isTypeOnly) continue;
      const text = clause!.trim();
      if (text.startsWith('*')) {
        findings.push(where(`namespace import of the client module ${relTarget(target)}`));
        continue;
      }
      const named = /^\{([\s\S]*)\}$/.exec(text);
      if (named) {
        for (const raw of named[1]!.split(',')) {
          const member = raw.trim();
          if (!member || member.startsWith('type ')) continue;
          const name = member.split(/\s+as\s+/)[0]!.trim();
          if (!isComponentName(name)) {
            findings.push(where(`imports "${name}" from the client module ${relTarget(target)}`));
          }
        }
      } else if (text) {
        const name = text.split(',')[0]!.trim();
        if (!isComponentName(name)) {
          findings.push(where(`imports "${name}" from the client module ${relTarget(target)}`));
        }
      }
    }

    const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
    while ((match = sideEffectRe.exec(source))) {
      const target = clientModuleAt(file, match[1]!);
      if (target) findings.push(where(`side-effect import of the client module ${relTarget(target)}`));
    }
  }
  return findings;
}

test('client boundary: server modules import only components from use-client modules', () => {
  assert.deepEqual(scanClientBoundary(), []);
});

test('client boundary: the guard recognises the shape it exists for', () => {
  // A self-check on the rule itself, so a future refactor of the scanner cannot
  // silently turn it into a no-op.
  assert.equal(isComponentName('PrivacyPanel'), true);
  assert.equal(isComponentName('CONSENT_PURPOSES_UI'), false);
  assert.equal(isComponentName('useToast'), false);
  assert.equal(isComponentName('defaultStrings'), false);
  // The privacy panel really is a client module and really is detected as one.
  const panel = path.resolve(SRC_DIR, 'app/me/privacy/privacy-panel.tsx');
  assert.ok(CLIENT_MODULES.has(panel), 'privacy-panel.tsx must be recognised as a client module');
  assert.ok(CLIENT_MODULES.size > 20, 'the scan must see the whole src/ tree');
});
