// Token Radar build entrypoint (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// validates and copies this repository's dashboard/ and screenshots/ to /output, then writes
// /output/dossier.json with the vendored make.fun library. It checks the sealed input, output bounds,
// watchlist eligibility, and repeatability before reporting a successful build.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. The page
// and board share one model result, keeping ranks, estimates, evidence and farm plans in agreement.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, isPreToken, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DASHBOARD_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DASHBOARD_CAPS = { files: 400, bytes: 4_194_304 };
const DOSSIER_MAX_BYTES = 1_572_864;
const PROTOCOL_FIELDS = ['slug', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'mcap_usd', 'listed_at', 'gecko_id', 'symbol'];

function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stdout.write('Usage: node main.ts [--input <snapshot.json|directory>] [--output <directory>] [--help]\n');
  process.exit(0);
}

/** Reject malformed input before parsing can normalize an invalid field into a plausible null. */
function validateSnapshotInput(rawText: string): void {
  let raw: unknown;
  try { raw = JSON.parse(rawText); } catch { fail('snapshot is not valid JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('snapshot root must be an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of) || !Number.isFinite(Date.parse(`${o.as_of}T00:00:00Z`)) || new Date(`${o.as_of}T00:00:00Z`).toISOString().slice(0, 10) !== o.as_of) fail('snapshot as_of must be a real YYYY-MM-DD calendar date');
  if (typeof o.source !== 'string' || !o.source.trim() || o.source.length > 500) fail('snapshot source must be a non-empty string of at most 500 characters');
  if (!Number.isSafeInteger(o.floor_usd) || Number(o.floor_usd) <= 0) fail('snapshot floor_usd must be a positive safe integer');
  if (!Array.isArray(o.protocols) || o.protocols.length < 100 || o.protocols.length > 20_000) fail('snapshot protocols array is outside the supported bounds');
  if (!Array.isArray(o.watchlist) || o.watchlist.length === 0 || o.watchlist.length > o.protocols.length) fail('snapshot watchlist is empty or outside the supported bounds');
  const seen = new Set<string>();
  for (let i = 0; i < o.protocols.length; i++) {
    const p = o.protocols[i];
    if (typeof p !== 'object' || p === null || Array.isArray(p)) fail(`protocol ${i} is not an object`);
    const entry = p as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(PROTOCOL_FIELDS.slice().sort())) fail(`protocol ${i} does not have the sealed ten-field shape`);
    if (typeof entry.slug !== 'string' || !/^[^\s]{1,128}$/.test(entry.slug) || seen.has(entry.slug)) fail(`protocol ${i} has an invalid or duplicate slug`);
    seen.add(entry.slug);
    if (typeof entry.name !== 'string' || !entry.name.trim()) fail(`protocol ${entry.slug} has no name`);
    if (entry.category !== null && typeof entry.category !== 'string') fail(`protocol ${entry.slug} has invalid category`);
    if (!Array.isArray(entry.chains) || entry.chains.some((c) => typeof c !== 'string' || !c.trim()) || new Set(entry.chains).size !== entry.chains.length) fail(`protocol ${entry.slug} has invalid or duplicate chains`);
    if (entry.listed_at !== null && (typeof entry.listed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.listed_at) || !Number.isFinite(Date.parse(`${entry.listed_at}T00:00:00Z`)) || new Date(`${entry.listed_at}T00:00:00Z`).toISOString().slice(0, 10) !== entry.listed_at)) fail(`protocol ${entry.slug} has invalid listed_at date`);
    if (!Number.isSafeInteger(entry.tvl_usd) || Number(entry.tvl_usd) < 5_000_000) fail(`protocol ${entry.slug} has invalid TVL`);
    for (const field of ['change_7d', 'mcap_usd']) if (entry[field] !== null && (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]))) fail(`protocol ${entry.slug} has invalid ${field}`);
    for (const field of ['listed_at', 'gecko_id', 'symbol']) if (entry[field] !== null && typeof entry[field] !== 'string') fail(`protocol ${entry.slug} has invalid ${field}`);
  }
  const watch = new Set<string>();
  for (const slug of o.watchlist) {
    if (typeof slug !== 'string' || watch.has(slug) || !seen.has(slug)) fail(`watchlist has duplicate or unknown slug ${String(slug)}`);
    watch.add(slug);
  }
}

/** Parse the PNG/JPEG header and enforce the judge's screenshot geometry and byte limits. */
function imageDimensions(bytes: Buffer, label: string): { width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
  }
  fail(`${label} is not a complete PNG or JPEG image`);
}

/** Enforce the input-to-board determinism promise before writing anything. */
function deterministicBuild(snapshot: ReturnType<typeof parseSnapshot>) {
  const first = buildRadar(snapshot);
  const second = buildRadar(snapshot);
  if (JSON.stringify(first) !== JSON.stringify(second)) fail('model output changed between identical in-memory builds');
  const issue = boardIssue(first.board, snapshot);
  if (issue !== null) fail(`board contract rejected: ${issue}`);
  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((row) => row.slug === slug);
    if (!p || !isPreToken(p)) fail(`watchlist entry ${slug} has recorded token fields or is missing`);
    // Lexically flagged watchlist rows remain covered; boardIssue checks this exception explicitly.
  }
  return first;
}

/** Parse only the two documented options; reject typos and ambiguous repeats. */
function argumentsFrom(argv: string[]): { input: string; output: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--help' || token === '-h') usage();
    const match = /^(--input|--output)(?:=(.*))?$/.exec(token);
    if (!match) fail(`unknown argument ${token}; use --help for usage`, 2);
    const key = match[1]!.slice(2);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value.length === 0 || value.startsWith('--')) fail(`${match[1]} requires a non-empty value`, 2);
    if (values.has(key)) fail(`${match[1]} was supplied more than once`, 2);
    values.set(key, value);
  }
  return { input: values.get('input') ?? '/input', output: values.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output' };
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve a not-yet-created output through its nearest real parent before mkdir can touch it. */
function projectedPath(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

const args = argumentsFrom(process.argv.slice(2));
const inputArg = resolve(args.input);
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
if (!statSync(inputFile).isFile()) fail(`input is not a regular file: ${inputFile}`, 2);
const out = resolve(args.output);
const repo = resolve(here);
const sourceAssets = [repo, join(repo, 'dashboard'), join(repo, 'screenshots')];
const resolvedInput = realpathSync(inputFile);
if (existsSync(out) && !lstatSync(out).isDirectory()) fail(`output path must be a directory, not a file or symlink: ${out}`, 2);
const projectedOut = projectedPath(out);
if (sourceAssets.some((source) => within(projectedOut, source) || within(source, projectedOut))) {
  fail(`output ${projectedOut} overlaps repository source; choose a separate output directory`, 2);
}
if (projectedOut === resolvedInput || within(projectedOut, resolvedInput)) fail(`output ${projectedOut} would overwrite or contain the input snapshot`, 2);

const inputText = readFileSync(inputFile, 'utf8');
validateSnapshotInput(inputText);
const snapshot = parseSnapshot(inputText);
const { board, radar } = deterministicBuild(snapshot);

mkdirSync(out, { recursive: true });
const realOut = realpathSync(out);
if (sourceAssets.some((source) => within(realOut, source) || within(source, realOut))) fail(`resolved output ${realOut} overlaps repository source`, 2);
// The output is generated data. Clear managed trees so an earlier build cannot leave stale assets.
rmSync(join(out, 'dashboard'), { recursive: true, force: true });
rmSync(join(out, 'screenshots'), { recursive: true, force: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > SCREENSHOT_CAPS.max) fail(`screenshots directory has ${shots.length} images; expected 3 to ${SCREENSHOT_CAPS.max}`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name} has a disallowed filename`);
  const bytes = readFileSync(join(out, 'screenshots', name));
  if (bytes.length > SCREENSHOT_CAPS.max_bytes) fail(`screenshots/${name} exceeds ${SCREENSHOT_CAPS.max_bytes} bytes`);
  const { width, height } = imageDimensions(bytes, `screenshots/${name}`);
  if (Math.max(width, height) > 1440 || Math.min(width, height) < 800) fail(`screenshots/${name} dimensions ${width}x${height} are outside 800..1440 limits`);
}

/** Audit copied static assets before dossier generation so an invalid page never looks complete. */
function validateDashboard(directory: string): void {
  let files = 0, total = 0, hasHtml = false, hasCss = false, hasJs = false;
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    if (!DASHBOARD_NAME.test(name)) fail(`dashboard filename ${name} is not allowed`);
    const path = join(directory, name), st = statSync(path);
    if (!st.isFile()) fail(`dashboard asset ${name} is not a regular file`);
    files++; total += st.size;
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    hasHtml ||= ext === 'html'; hasCss ||= ext === 'css'; hasJs ||= ext === 'js';
    const source = readFileSync(path, 'utf8');
    if (/https?:\/\//i.test(source)) fail(`dashboard asset ${name} contains a network address`);
  }
  if (files > DASHBOARD_CAPS.files || total > DASHBOARD_CAPS.bytes) fail(`dashboard has ${files} files / ${total} bytes, over its artifact bounds`);
  if (!hasHtml || !hasCss || !hasJs || !existsSync(join(directory, 'index.html'))) fail('dashboard is missing index.html, CSS or JavaScript');
}

validateDashboard(join(out, 'dashboard'));

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: DASHBOARD_CAPS.files, max_bytes: DASHBOARD_CAPS.bytes } }));
const dossierBytes = statSync(join(out, 'dossier.json')).size;
if (dossierBytes > DOSSIER_MAX_BYTES) fail(`dossier is ${dossierBytes} bytes, above ${DOSSIER_MAX_BYTES}`);
const persistedBoard = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows?: unknown };
if (!Array.isArray(persistedBoard.rows) || JSON.stringify(persistedBoard.rows) !== JSON.stringify(radar.rows)) fail('board.json and dashboard data diverged');
if (radar.rows.length > 1 && new Set(radar.rows.map((row) => row.implied_value_usd)).size === 1) fail('board has no value differentiation');
const boardBytes = statSync(join(out, 'board.json')).size;
if (boardBytes > 8_388_608) fail(`board.json is ${boardBytes} bytes, above 8 MiB`);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
[exit status 0]