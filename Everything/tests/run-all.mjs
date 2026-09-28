// Runs every suite and reports honestly, which chaining them with `&&` in `npm test` did not.
//
//   node Everything/tests/run-all.mjs            every suite
//   node Everything/tests/run-all.mjs ask ui     only the named ones
//   node Everything/tests/run-all.mjs --bail     stop at the first failure
//
// Why this exists, because the old script failed in a quiet way:
//
//   "test": "node a.mjs && node b.mjs && node c.mjs && ..."
//
// `&&` means the first suite that exits non-zero ends the whole run, and a suite that could not
// even start exits non-zero. Playwright is declared in devDependencies but is absent on a fresh
// clone until `npm install` runs, so `plan-probe.mjs` died with ERR_MODULE_NOT_FOUND and the six
// suites after it never ran at all. The output just stopped mid-list, which reads as "finished" —
// six suites of coverage silently vanished and the exit code was the only clue.
//
// So: every suite runs, each under its own hard timeout (a hung browser or a hung socket can no
// longer block the terminal), and a missing dependency is reported as SKIPPED with the reason
// rather than as a silent truncation.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { name: 'ui', file: 'ui-structure.test.mjs', timeoutMs: 120000 },
  { name: 'ask', file: 'ask-adapter.test.mjs', timeoutMs: 120000 },
  { name: 'mobile', file: 'mobile-audit.mjs', timeoutMs: 120000 },
  { name: 'plan', file: 'plan-probe.mjs', timeoutMs: 120000 },
  { name: 'visual', file: 'plan-visual.mjs', timeoutMs: 120000 },
  { name: 'autosave', file: 'autosave-probe.mjs', timeoutMs: 120000 },
  { name: 'theme', file: 'theme-probe.mjs', timeoutMs: 120000 },
  { name: 'back', file: 'back-nav-probe.mjs', timeoutMs: 120000 },
  { name: 'search', file: 'search-probe.mjs', timeoutMs: 120000 },
  // The inline-help notes are the one feature whose whole job is to be seen. A probe that only
  // checked the CSS existed would pass while nothing was ever visible to anyone.
  { name: 'help', file: 'help-probe.mjs', timeoutMs: 120000 },
  // Dictation and pictures used to be stored and never understood: the channel and the kind were
  // one variable, so every smart-capture rule had to skip them.
  { name: 'voice', file: 'voice-understanding-probe.mjs', timeoutMs: 120000 },
  // The next-step card, and above all that it stops asking once it has been turned down.
  { name: 'nextaction', file: 'next-action-probe.mjs', timeoutMs: 120000 },
  // Mostly about silence: a daily notification that nags is worse than none.
  { name: 'digest', file: 'morning-digest-probe.mjs', timeoutMs: 120000 },
  // Sharing must be a real top-level navigation, or the test passes while the feature is dead.
  { name: 'share', file: 'share-target-probe.mjs', timeoutMs: 180000 },
  // The missing half of the loop: what has quietly stopped moving.
  { name: 'review', file: 'review-probe.mjs', timeoutMs: 120000 },
  // What makes a free tunnel usable from a phone: pasting the banner, and a stale address.
  { name: 'localmodel', file: 'local-model-url-probe.mjs', timeoutMs: 120000 },
  // The one thing that can lose data: two devices offline at the same time.
  { name: 'sync', file: 'sync-conflict-probe.mjs', timeoutMs: 120000 },
  // A collection written to but never subscribed to survived for a long time, and so can anything
  // else that merely looks plausible. This is the net for the next one.
  { name: 'deadcode', file: '../../dead-code-audit.mjs', timeoutMs: 60000 },
  // Signing out cleared the Supabase session but left the local state, which one key shared by
  // every account on the device. The next person to sign in inherited it — and the merge pushed
  // it into their account.
  { name: 'signout', file: 'signout-probe.mjs', timeoutMs: 120000 },
];

const args = process.argv.slice(2);
const bail = args.includes('--bail');
const wanted = new Set(args.filter((a) => !a.startsWith('--')));
const selected = wanted.size ? SUITES.filter((s) => wanted.has(s.name)) : SUITES;

const ANSI = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const paint = (color, text) => (process.stdout.isTTY ? `${ANSI[color]}${text}${ANSI.off}` : text);

// A suite that dies on a missing package is not a test failure and must not look like one — but it
// is also not a pass, because the coverage it stood for is not happening.
const MISSING_MODULE = /Cannot find package '([^']+)'/;
const FAILED_TO_START = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_ESM_URL_SCHEME/;

function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(here, suite.file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, suite.timeoutMs);

    // A kill is not instant on Windows and a stubborn child can outlive its parent, so give up on
    // waiting for an event that has become a formality.
    const backstop = setTimeout(() => child.kill(), suite.timeoutMs + 5000);
    backstop.unref?.();

    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      resolve({ suite, out, status, timedOut, ms: Date.now() - started });
    };

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => finish('spawn-error'));
    child.on('close', (code) => finish(code === 0 ? 'passed' : 'failed'));
  });
}


const summary = [];
let failed = 0;
let skipped = 0;

for (const suite of selected) {
  process.stdout.write(`${paint('dim', `→ ${suite.name} (${(suite.timeoutMs / 1000) | 0}s budget)`)}\n`);
  const r = await runSuite(suite);

  const pkg = MISSING_MODULE.exec(r.out)?.[1] || (FAILED_TO_START.test(r.out) ? 'its dependency' : null);
  // Each suite prints its own banner, and the wording is not uniform — `ALL 7 AUTO-SAVE CHECKS
  // PASSED` has a hyphen, so the character class has to allow one or the suite is scored as failed
  // while its output plainly says otherwise.
  const verdict = /ALL (\d+) [A-Z -]*PASSED/.exec(r.out);

  let state;
  if (r.timedOut) state = 'TIMEOUT';
  else if (pkg) state = 'skipped';
  else if (r.status === 'passed' && verdict) state = 'passed';
  else state = 'failed';

  if (state === 'passed') summary.push({ name: suite.name, state, note: `${verdict[1]} checks in ${(r.ms / 1000).toFixed(1)}s` });
  else if (state === 'skipped') { skipped += 1; summary.push({ name: suite.name, state, note: `missing "${pkg}" — run npm install` }); }
  else if (state === 'TIMEOUT') { failed += 1; summary.push({ name: suite.name, state, note: `over ${(suite.timeoutMs / 1000) | 0}s, killed` }); }
  else { failed += 1; summary.push({ name: suite.name, state, note: `exit ${r.status} in ${(r.ms / 1000).toFixed(1)}s` }); }

  const colour = state === 'passed' ? 'green' : state === 'skipped' ? 'yellow' : 'red';
  // A skipped suite prints nothing extra: the note below already says exactly what is missing.
  const detail = state === 'failed' || state === 'TIMEOUT' ? `\n${r.out.trim()}\n` : '';
  console.log(`${paint(colour, state.toUpperCase().padEnd(8))} ${suite.name}${detail}`);

  if (bail && (state === 'failed' || state === 'TIMEOUT')) break;
}

console.log(`\n${paint('bold', 'Summary')}`);
for (const s of summary) {
  const mark = s.state === 'passed' ? paint('green', '  ok  ') : s.state === 'skipped' ? paint('yellow', ' skip ') : paint('red', ' FAIL ');
  console.log(`${mark} ${s.name.padEnd(10)} ${s.note}`);
}

const ok = summary.filter((s) => s.state === 'passed').length;
console.log(`\n${summary.length} of ${selected.length} suites ran — ${ok} passed, ${failed} failed, ${skipped} skipped.`);

if (skipped) {
  // This is precisely the silent-truncation bug being recreated by a missing dependency, so it is
  // called out loudly rather than left for someone to spot in a wall of green.
  console.log(paint('yellow', `\n${skipped} suite(s) did not run. That is missing coverage, not a pass.`));
  console.log('Run `npm install`, then re-run. Set ALLOW_SKIP=1 to accept a partial run.');
}
if (failed) console.log(paint('red', `${failed} suite(s) failed.`));

process.exit(failed || (skipped && !process.env.ALLOW_SKIP) ? 1 : 0);
