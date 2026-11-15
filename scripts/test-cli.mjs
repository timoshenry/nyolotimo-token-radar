#!/usr/bin/env node
// Process-level regression coverage for argument parsing and output path safety.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaultSnapshot = '/workspace/token-radar-kit/token-radar-01-kit/input/snapshot.json';
const snapshot = resolve(process.argv[2] || defaultSnapshot);
const main = join(root, 'main.ts');
const scratch = mkdtempSync(join(tmpdir(), 'token-radar-cli-'));

function cli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [main, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: join(scratch, 'default-output'), ...env },
  });
  assert.equal(result.error, undefined, `could not start CLI: ${result.error}`);
  return result;
}

function rejected(args, expected, status = 2) {
  const result = cli(args);
  assert.equal(
    result.status,
    status,
    `expected exit ${status} for ${args.join(' ')}; got ${result.status}\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stderr, expected, `unexpected diagnostic for ${args.join(' ')}`);
  return result;
}

function expectArtifact(directory, name) {
  const bytes = readFileSync(join(directory, name));
  assert.ok(bytes.length > 0, `${name} missing or empty after normal build`);
}

try {
  const help = cli(['--help']);
  assert.equal(help.status, 0, `--help failed: ${help.stderr}`);
  assert.match(help.stdout, /Usage: node main\.ts/);
  assert.equal(help.stderr, '', '--help should not emit an error');

  // Parser failures must stop before an input read or output write is attempted.
  rejected(['--wat'], /unknown argument --wat/);
  rejected(['--input', snapshot, '--input', snapshot], /--input was supplied more than once/);
  rejected(['--output'], /--output requires a non-empty value/);
  rejected(['--input', '--output', join(scratch, 'bad')], /--input requires a non-empty value/);
  rejected(['--output='], /--output requires a non-empty value/);

  // A successful child process must produce the public artifacts in an isolated directory.
  const good = join(scratch, 'good-build');
  const built = cli(['--input', snapshot, '--output', good]);
  assert.equal(built.status, 0, `normal build failed:\n${built.stderr}\n${built.stdout}`);
  for (const name of ['board.json', 'data.js', 'dossier.json']) expectArtifact(good, name);
  expectArtifact(good, join('dashboard', 'index.html'));

  // Directory input resolves snapshot.json; equals-form flags follow the same path.
  const inputDirectory = join(scratch, 'directory-input');
  mkdirSync(inputDirectory);
  writeFileSync(join(inputDirectory, 'snapshot.json'), readFileSync(snapshot));
  const directoryBuild = join(scratch, 'directory-build');
  const directoryResult = cli(['--input', inputDirectory, '--output', directoryBuild]);
  assert.equal(directoryResult.status, 0, `directory input failed:\n${directoryResult.stderr}`);
  expectArtifact(directoryBuild, 'board.json');

  const equalsBuild = join(scratch, 'equals-build');
  const equalsResult = cli([`--input=${inputDirectory}`, `--output=${equalsBuild}`]);
  assert.equal(equalsResult.status, 0, `equals-form flags failed:\n${equalsResult.stderr}`);
  for (const name of ['board.json', 'data.js', 'dossier.json']) expectArtifact(equalsBuild, name);

  // Rejected snapshots must not clear or partially populate an existing output.
  function assertRejectedInputDoesNotWrite(label, inputText, expected) {
    const badInputDirectory = join(scratch, `${label}-input`);
    mkdirSync(badInputDirectory);
    const badInput = join(badInputDirectory, 'snapshot.json');
    writeFileSync(badInput, inputText);
    const output = join(scratch, `${label}-output`);
    mkdirSync(output);
    writeFileSync(join(output, 'sentinel.txt'), 'preserve existing output');
    const result = cli([`--input=${badInput}`, `--output=${output}`]);
    assert.equal(result.status, 1, `${label} should be rejected:\n${result.stderr}`);
    assert.match(result.stderr, expected, `${label} diagnostic was unexpected`);
    assert.deepEqual(readdirSync(output).sort(), ['sentinel.txt'], `${label} wrote partial artifacts`);
    assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), 'preserve existing output');
  }

  assertRejectedInputDoesNotWrite('malformed-json', '{"as_of":', /snapshot is not valid JSON/);
  const invalidShape = JSON.parse(readFileSync(snapshot, 'utf8'));
  delete invalidShape.protocols[0].symbol;
  assertRejectedInputDoesNotWrite('invalid-shape', JSON.stringify(invalidShape), /protocol 0 does not have the sealed ten-field shape/);

  // Both the repository root and descendants are protected from destructive output.
  rejected(['--input', snapshot, '--output', join(root, 'cli-test-output')], /overlaps repository source/);
  rejected(['--input', snapshot, '--output', join(root, 'dashboard', 'cli-test-output')], /overlaps repository source/);

  // A symlink resolving to source must never be accepted as an output directory.
  const link = join(scratch, 'source-link');
  symlinkSync(join(root, 'dashboard'), link, 'dir');
  rejected(['--input', snapshot, '--output', link], /output path must be a directory, not a file or symlink/);

  // An output directory cannot contain the snapshot it was asked to read.
  const snapshotDir = join(scratch, 'input-tree');
  mkdirSync(snapshotDir);
  const copiedSnapshot = join(snapshotDir, 'snapshot.json');
  writeFileSync(copiedSnapshot, readFileSync(snapshot));
  rejected(['--input', copiedSnapshot, '--output', snapshotDir], /would overwrite or contain the input snapshot/);

  // Refusing a regular file must leave that file's contents untouched.
  const regularFile = join(scratch, 'output-file');
  writeFileSync(regularFile, 'keep me');
  rejected(['--input', snapshot, '--output', regularFile], /output path must be a directory, not a file or symlink/);
  assert.equal(readFileSync(regularFile, 'utf8'), 'keep me', 'rejected file output was modified');

  console.log('PASS: CLI help, argument forms, snapshot rejection safety, normal build, and unsafe output path regressions.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
[exit status 0]