#!/usr/bin/env node
// End-to-end integrity check for the sealed token-radar build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';
import { exclusionReason, parseSnapshot } from '../lib/model.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const snapshotPath = process.argv[2] || '/workspace/token-radar-kit/token-radar-01-kit/input/snapshot.json';
assert.ok(statSync(snapshotPath).isFile(), `sealed snapshot not found: ${snapshotPath}`);
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'token-radar-validate-'));

function inventory(path, base = path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const target = join(path, entry.name);
    if (entry.isDirectory()) return inventory(target, base);
    assert.ok(entry.isFile(), `unexpected non-file artifact: ${target}`);
    return [[relative(base, target), readFileSync(target)]];
  });
}

function run(output) {
  const result = spawnSync(process.execPath, ['main.ts', '--input', snapshotPath, '--output', output], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `main.ts failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  assert.ok(readFileSync(join(output, 'dossier.json'), 'utf8').length > 0, 'dossier.json is absent or empty');
  return result.stdout.trim();
}

function checkOutput(output) {
  const boardBytes = readFileSync(join(output, 'board.json'));
  assert.ok(boardBytes.length <= 8 * 1024 * 1024, 'board.json exceeds 8 MiB');
  const { rows } = JSON.parse(boardBytes.toString('utf8'));
  assert.ok(rows.length >= 100 && rows.length <= 4000, `row count outside contract: ${rows.length}`);
  const protocolBySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const rowSlugs = new Set(rows.map((row) => row.slug));
  assert.equal(rowSlugs.size, rows.length, 'board contains duplicate slugs');
  for (const slug of snapshot.watchlist) assert.ok(rowSlugs.has(slug), `watchlist slug missing: ${slug}`);
  for (const row of rows) {
    assert.ok(protocolBySlug.has(row.slug), `unknown board slug: ${row.slug}`);
    assert.equal(exclusionReason(protocolBySlug.get(row.slug)), null, `ineligible row ranked: ${row.slug}`);
    assert.ok(Array.isArray(row.farm_steps) && row.farm_steps.length >= 3 && row.farm_steps.length <= 12, `${row.slug} farm plan step count`);
    for (const step of row.farm_steps) assert.ok(typeof step === 'string' && step.trim().length >= 20 && step.trim().length <= 600, `${row.slug} has an invalid farm step`);
  }
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].implied_value_usd >= rows[i].implied_value_usd, `value order breaks at row ${i + 1}`);

  const shotsDir = join(output, 'screenshots');
  const shots = readdirSync(shotsDir).filter((name) => !name.startsWith('.'));
  assert.ok(shots.length >= 3 && shots.length <= 4, `screenshot count outside contract: ${shots.length}`);
  for (const name of shots) {
    const bytes = readFileSync(join(shotsDir, name));
    assert.ok(bytes.length <= 512 * 1024, `${name} exceeds 512 KiB`);
    assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} is not a complete PNG screenshot`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert.ok(Math.max(width, height) <= 1440 && Math.min(width, height) >= 800, `${name} has invalid dimensions ${width}x${height}`);
  }

  const dashboard = join(output, 'dashboard');
  const files = inventory(dashboard);
  assert.ok(files.some(([name]) => name === 'index.html'), 'dashboard index.html missing');
  assert.ok(files.some(([name]) => name.endsWith('.css')), 'dashboard CSS missing');
  assert.ok(files.some(([name]) => name.endsWith('.js')), 'dashboard JavaScript missing');
  assert.ok(files.length <= 400, 'dashboard has more than 400 files');
  assert.ok(files.reduce((n, [, bytes]) => n + bytes.length, 0) <= 4 * 1024 * 1024, 'dashboard exceeds 4 MiB');
  for (const [name, bytes] of files) assert.doesNotMatch(bytes.toString('utf8'), /https?:\/\//i, `${name} contains a network address`);

  const expectedDossier = buildDossier(output, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
  const dossier = readFileSync(join(output, 'dossier.json'));
  assert.ok(dossier.length <= 1_572_864, 'dossier exceeds 1.5 MiB');
  assert.deepEqual(dossier, Buffer.from(expectedDossier), 'dossier differs from vendor buildDossier');
}

try {
  const first = join(scratch, 'first'), second = join(scratch, 'second');
  mkdirSync(join(first, 'dashboard'), { recursive: true });
  writeFileSync(join(first, 'dashboard', 'stale.js'), 'must be removed by the next build');
  const firstLog = run(first), secondLog = run(second);
  checkOutput(first); checkOutput(second);
  const a = inventory(first), b = inventory(second);
  assert.deepEqual(a.map(([name]) => name), b.map(([name]) => name), 'output file lists differ');
  for (let i = 0; i < a.length; i++) assert.deepEqual(a[i][1], b[i][1], `nondeterministic artifact: ${a[i][0]}`);
  console.log(`PASS: two deterministic builds; ${snapshot.protocols.length} snapshot protocols; ${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist covered; ${JSON.parse(readFileSync(join(first, 'board.json'), 'utf8')).rows.length} eligible rows; ${readdirSync(join(first, 'screenshots')).length} screenshots; dossier matches buildDossier.`);
  console.log(`Build logs: ${firstLog.split('\n')[0]} | ${secondLog.split('\n')[0]}`);
  const cliTests = spawnSync(process.execPath, [join(root, 'scripts', 'test-cli.mjs'), snapshotPath], {
    cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(cliTests.status, 0, `CLI regression suite failed (${cliTests.status}):\n${cliTests.stderr}\n${cliTests.stdout}`);
  process.stdout.write(cliTests.stdout);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
[exit status 0]