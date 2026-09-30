// A fast structural check to run after EVERY edit, not only before a test run.
//
//   node Everything/tests/verify.mjs
//
//   npm run verify
//
// `node --check` on its own only proves a file parses. That is not enough, because the failure
// mode that actually happened here was an edit landing in the wrong place *inside a well-formed
// file*:
//
//   - a duplicated `} finally {`, which is a parse error and is caught;
//   - and an `await check(...)` line that a replacement deleted rather than added to, which is
//     perfectly valid JavaScript. The suite runs, prints one fewer line, and reports success.
//
// The second is the dangerous one, so this also checks that the probes are *shaped* correctly:
// the check count declared by the banner, no check nested inside another, and no file left with
// a temporary marker in it. Cheap enough to run on every save, which is the point.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const problems = [];
const note = (message) => problems.push(message);

/* ---------- 1. Every file parses ---------- */

/* The app logic is fifteen files in Everything/js, in the load order index.html writes down. Reading
   the order from there means a new part is parsed the day it is added, and a part that is added but
   never loaded is still caught — which a hard-coded list would have missed silently. */
const appDir = path.join(repo, 'Everything');
const htmlSource = readFileSync(path.join(appDir, 'index.html'), 'utf8');
const appScripts = [...htmlSource.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map((m) => m[1]);

const files = [
  ...appScripts.map((rel) => path.join(appDir, rel)),
  path.join(repo, 'serve.mjs'),
  path.join(here, 'run-all.mjs'),
  ...readdirSync(here)
    .filter((name) => name.endsWith('.mjs') || name.endsWith('.js'))
    .map((name) => path.join(here, name)),
];

// A part in Everything/js that index.html never loads is dead weight in the shell, and nothing else
// would ever notice it — so the directory is compared against the load order, both directions.
const jsParts = readdirSync(path.join(appDir, 'js')).filter((n) => n.endsWith('.js'));
for (const name of jsParts) {
  if (!appScripts.includes(`js/${name}`)) note(`ORPHAN Everything/js/${name} is never loaded by index.html.`);
}
for (const rel of appScripts) {
  if (!existsSync(path.join(appDir, rel))) note(`SHELL Everything/${rel} is loaded but missing.`);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const where = path.relative(repo, file);
    // Keep only the line that names a file and a position. The lines around it are Node's module
    // loader stack trace and carry nothing a reader can act on.
    const line = (result.stderr || '')
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => /^\S+\.(mjs|js):\d+$/.test(entry));
    note(`PARSE  ${where}\n       ${line || 'parse failed (run: node --check ' + where + ')'}`);
  }
}

/* ---------- 2. No leftover scaffolding ---------- */

// A debug log or a temporary probe that shipped is a real defect, not a style note: it was in
// script.js once already, from a diagnostic that was meant to be removed after use.
// The app logic is fifteen files now, so every part is checked and the file is named in the report.
// A leftover diagnostic is exactly as bad in js/capture.js as it was in one script.js.
for (const rel of appScripts) {
  const full = path.join(appDir, rel);
  if (!existsSync(full)) {
    note(`SHELL  Everything/${rel} is loaded by index.html but the file is missing.`);
    continue;
  }
  readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
    if (/console\.log\((['"`]|\s*)\s*(swipe decided|PAGE:|bound |after |row |setup|probe)\b/.test(line)) {
      note(`DEBUG  Everything/${rel}:${i + 1} looks like a leftover diagnostic: ${line.trim().slice(0, 70)}`);
    }
  });
}

for (const name of readdirSync(here)) {
  if (/^_/.test(name) && /\.(mjs|js|cjs)$/.test(name)) {
    note(`TEMP   Everything/tests/${name} is a temporary diagnostic file. Delete it before committing.`);
  }
}

/* ---------- 3. The probes are shaped correctly ---------- */

const probeFiles = readdirSync(here).filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs' && name !== 'verify.mjs');

for (const name of probeFiles) {
  const source = readFileSync(path.join(here, name), 'utf8');

  // A check nested inside another is the signature of a truncated body: the arrow function was cut
  // short, so the following `await check(...)` ended up inside it and stopped running.
  const depth = [];
  let lineNo = 0;
  let broke = false;
  for (const line of source.split('\n')) {
    lineNo += 1;
    if (/await check\(|^\s*check\(/.test(line)) depth.push(lineNo);
    // Close an arrow-function body: a line that is just `});` at or below the open indentation.
    if (/^\s*\}\);\s*$/.test(line) && depth.length) depth.pop();
  }
  if (depth.length > 1) {
    note(`NESTED ${name}: a check() body is still open from line ${depth[0]} — a later check was likely swallowed by a truncated one.`);
  }

  // The banner count must be the number that ran, not the number that passed. A pass-count banner
  // prints "ALL 14 PASSED" beside two FAILs, which is worse than no banner: the exit code is the
  // only thing that disagrees with the sentence directly above it.
  //
  // Matched against the shape the suites actually use —
  //   console.log(process.exitCode ? '...\n...FAILED' : `\nALL ${results.length} ... PASSED`);
  // — rather than a single canonical string, because every suite words its own label
  // ("AUTO-SAVE CHECKS", "NEXT-ACTION CHECKS", "TESTS"). An earlier version of this check demanded
  // one exact form and flagged fifteen healthy files, which is the same mistake this whole script
  // exists to prevent: asserting a shape the codebase does not actually use.
  const usesResults = /const results = \[\]/.test(source);
  const bannerShape = /ALL \$\{results\.length\}/.test(source);
  if (usesResults && !bannerShape) {
    note(`BANNER ${name}: results.length is never printed, so run-all.mjs cannot score this suite.`);
  }
  if (/\.filter\(\(?\w+\)? => \w+\.startsWith\('PASS'\)\)/.test(source)) {
    note(`BANNER ${name}: the banner counts only passes, so it can claim success beside a failure. Use results.length.`);
  }
}

/* ---------- 4. Every suite in the runner exists on disk ---------- */

const runner = readFileSync(path.join(here, 'run-all.mjs'), 'utf8');
const onDisk = new Set(readdirSync(here));
for (const match of runner.matchAll(/file:\s*'([^']+)'/g)) {
  const target = match[1];
  if (!onDisk.has(target) && !target.startsWith('..')) {
    note(`MISSING run-all.mjs lists ${target}, which is not in Everything/tests/.`);
  }
}

if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
  console.log(problems.join('\n\n'));
  console.log('\nFix these before running a suite. A malformed file makes every result below meaningless.');
  process.exit(1);
}

console.log(`VERIFY OK - ${files.length} files parse, ${probeFiles.length} probes well-shaped, no scaffolding left.`);

/* The banner run-all.mjs scores on. It is printed only after every problem list is empty, so the
   two can never disagree — which is the rule the other suites broke. */
console.log(`\nALL ${files.length + probeFiles.length} VERIFY CHECKS PASSED`);
