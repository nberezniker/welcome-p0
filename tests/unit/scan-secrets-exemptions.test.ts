import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPTION_MARKER, MIN_REASON_LENGTH, scanText } from '../../scripts/scan-secrets.mjs';

/**
 * The secret gate's exemption mechanism (`secret-scan:allow <reason>`).
 *
 * The point of these tests is that the mechanism stays a REVIEW device and not
 * a bypass: an unmarked literal must still fail, and a marker only counts when
 * it is a comment with a real reason. The end-to-end half runs the actual
 * `scripts/scan-secrets.mjs` CLI against a throwaway git repo, so the exit code
 * (what `pnpm gates` and CI actually read) is asserted, not just the pure
 * helper.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = path.join(REPO_ROOT, 'scripts', 'scan-secrets.mjs');

/**
 * A line the scanner's assigned-literal rule matches, assembled from pieces.
 * Written literally (`api_key: 'ZZZ…'`) this very test file would be a hit and
 * need an exemption of its own — which is exactly the problem the mechanism
 * exists to solve, so the fixture takes the long way round to stay honest.
 */
const POISON_NAME = ['api', 'key'].join('_');
const POISON_VALUE = 'Z'.repeat(24);
const poisonLine = (suffix = '') => `${POISON_NAME}: '${POISON_VALUE}'${suffix}`;

const REASON = 'synthetic fixture, invented for this test';

/**
 * The marker word, assembled from pieces for the same reason as POISON_NAME:
 * written literally, every line below that quotes it would itself be an
 * exemption marker on a line that matches nothing — the scanner would report a
 * pile of STALE EXEMPTIONs coming from the test that describes the mechanism.
 */
const MARKER = ['secret-scan', 'allow'].join(':');
/** A comment carrying the marker, i.e. what a developer would write. */
const marker = (reason: string) => ` // ${MARKER}${reason.length > 0 ? ` ${reason}` : ''}`;

function tmpRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scan-secrets-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function writeTracked(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content, 'utf8');
  execFileSync('git', ['add', '--', file], { cwd: dir });
}

function runScanner(dir: string) {
  return spawnSync(process.execPath, [SCANNER, '--root', dir], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// scanText — the pure rule set the CLI is built on
// ---------------------------------------------------------------------------

test('scan-secrets: an UNMARKED literal is still a hit', () => {
  const found = scanText(`${poisonLine()}\n`, 'fixture.ts');
  assert.equal(found.hits.length, 1, 'an unmarked literal must fail the gate');
  assert.equal(found.hits[0]?.pattern, 'assigned password literal');
  assert.equal(found.hits[0]?.line, 1);
  assert.equal(found.exemptions.length, 0);
  assert.equal(found.malformed.length, 0);
});

test('scan-secrets: a commented marker with a real reason exempts the line and is reported', () => {
  const found = scanText(`${poisonLine(marker(REASON))}\n`, 'fixture.ts');
  assert.equal(found.hits.length, 0, 'a valid exemption is not a hit');
  assert.equal(found.malformed.length, 0);
  assert.equal(found.exemptions.length, 1);
  assert.equal(found.exemptions[0]?.file, 'fixture.ts');
  assert.equal(found.exemptions[0]?.line, 1);
  assert.equal(found.exemptions[0]?.pattern, 'assigned password literal');
  assert.equal(found.exemptions[0]?.reason, REASON, 'the reason survives verbatim for the printed report');
});

test('scan-secrets: a block comment carries the marker too', () => {
  const found = scanText(`${poisonLine(` /* ${MARKER} ${REASON} */`)}\n`, 'fixture.ts');
  assert.equal(found.hits.length, 0);
  assert.equal(found.exemptions[0]?.reason, REASON, 'the trailing */ is not part of the reason');
});

test('scan-secrets: a missing or too-short reason does NOT exempt — it stays a hit', () => {
  for (const suffix of [marker(''), marker('x'), marker('too short')]) {
    const found = scanText(`${poisonLine(suffix)}\n`, 'fixture.ts');
    assert.equal(found.exemptions.length, 0, `'${suffix}' must not exempt`);
    assert.equal(found.malformed.length, 1, `'${suffix}' is reported as a malformed marker`);
    assert.equal(found.hits.length, 0, 'a malformed marker is reported once, as malformed');
  }
});

test('scan-secrets: only the exact marker word counts — near-misses are plain hits', () => {
  // Not a comment opener: the marker cannot be smuggled in as data.
  const noOpener = scanText(`${poisonLine(` ${MARKER} ${REASON}`)}\n`, 'fixture.ts');
  assert.equal(noOpener.exemptions.length, 0, 'a marker without a comment opener must not count');
  assert.equal(noOpener.hits.length, 1);

  // A marker word with a suffix (`…allowed`) is a different word, not a marker.
  const nearMiss = scanText(`${poisonLine(` // ${MARKER}d ${REASON}`)}\n`, 'fixture.ts');
  assert.equal(nearMiss.exemptions.length, 0, 'a suffixed marker word is not a marker');
  assert.equal(nearMiss.hits.length, 1);
});

test('scan-secrets: a marker on a line that matches nothing is reported as stale', () => {
  const found = scanText(`const unrelated = 1;${marker(REASON)}\n`, 'fixture.ts');
  assert.equal(found.hits.length, 0);
  assert.equal(found.exemptions.length, 0);
  assert.equal(found.stale.length, 1, 'an exemption that protects nothing should be visible as such');
  assert.equal(found.stale[0]?.line, 1);
});

test('scan-secrets: an exemption is per LINE, not per file', () => {
  const content = [
    poisonLine(marker(REASON)),
    poisonLine(),
    '',
  ].join('\n');
  const found = scanText(content, 'fixture.ts');
  assert.equal(found.exemptions.length, 1, 'line 1 is exempt');
  assert.equal(found.hits.length, 1, 'line 2 is not — the exemption does not leak');
  assert.equal(found.hits[0]?.line, 2);
});

test('scan-secrets: the marker and the minimum reason length are the documented ones', () => {
  assert.equal(MIN_REASON_LENGTH, 12);
  assert.match(`// ${MARKER} ${REASON}`, EXEMPTION_MARKER);
  assert.doesNotMatch(`# ${MARKER}ds`, EXEMPTION_MARKER);
});

// ---------------------------------------------------------------------------
// The CLI — what `pnpm gates` and CI actually execute
// ---------------------------------------------------------------------------

test('scan-secrets CLI: exits 1 on an unmarked literal and 0 once it is exempted', () => {
  const dir = tmpRepo();
  try {
    writeTracked(dir, 'fixture.ts', `${poisonLine()}\n`);

    const fail = runScanner(dir);
    assert.equal(fail.status, 1, 'the gate must fail on an unmarked literal');
    assert.match(fail.stderr, /SECRET HIT \[assigned password literal\] fixture\.ts:1/);
    assert.match(fail.stderr, /scan:secrets FAILED — 1 potential secret\(s\) found/);

    // Same literal, now with a documented reason: the gate passes and PRINTS it.
    writeTracked(dir, 'fixture.ts', `${poisonLine(marker(REASON))}\n`);
    const pass = runScanner(dir);
    assert.equal(pass.status, 0, 'a documented exemption must unblock the gate');
    assert.match(pass.stdout, /EXEMPTION \[assigned password literal\] fixture\.ts:1/);
    assert.match(pass.stdout, new RegExp(REASON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(pass.stdout, /1 documented exemption\(s\), 0 stale/);

    // ...and a marker without a reason puts the gate straight back to failing.
    writeTracked(dir, 'fixture.ts', `${poisonLine(marker('x'))}\n`);
    const malformed = runScanner(dir);
    assert.equal(malformed.status, 1, 'a marker with no real reason must not unblock the gate');
    assert.match(malformed.stderr, /marker is not a valid exemption/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan-secrets CLI: the committed working tree passes with its exemptions listed', () => {
  const result = spawnSync(process.execPath, [SCANNER], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `scan:secrets must pass on the committed tree:\n${result.stderr}`);
  assert.match(result.stdout, /^EXEMPTION \[/m, 'exemptions are printed on a green run, never hidden');
  assert.match(result.stdout, /scan:secrets ok — no secrets found in tracked files/);
});
