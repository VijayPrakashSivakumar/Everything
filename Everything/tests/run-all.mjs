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
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  { name: 'motion', file: 'motion-probe.mjs', timeoutMs: 120000 },
  { name: 'layers', file: 'layers-probe.mjs', timeoutMs: 120000 },
  { name: 'datetime', file: 'datetime-probe.mjs', timeoutMs: 120000 },
  { name: 'voiceimage', file: 'voice-image-probe.mjs', timeoutMs: 120000 },
  { name: 'back', file: 'back-nav-probe.mjs', timeoutMs: 120000 },
  { name: 'search', file: 'search-probe.mjs', timeoutMs: 120000 },
  // The inline-help notes are the one feature whose whole job is to be seen. A probe that only
  // checked the CSS existed would pass while nothing was ever visible to anyone.
  { name: 'help', file: 'help-probe.mjs', timeoutMs: 120000 },
  // Dictation and pictures used to be stored and never understood: the channel and the kind were
  // one variable, so every smart-capture rule had to skip them.
  { name: 'voice', file: 'voice-understanding-probe.mjs', timeoutMs: 120000 },
  // A reminder could be asked *whether* to keep it but never *when*: the only route to a date was
  // a date picker. This drives the whole exchange, and pins the two ways it could break the rest.
  { name: 'conversation', file: 'conversation-engine-probe.mjs', timeoutMs: 120000 },
  // A date on a picture says when, not what. Filing a photographed appointment card as a task on a
  // silent guess is the outcome nobody asked for, so the one decision is offered instead.
  { name: 'imagechoice', file: 'image-choice-probe.mjs', timeoutMs: 120000 },
  // Someone locked out of their account pressing "forgot password" and seeing nothing has nowhere
  // to go next, so every outcome of that screen has to say something.
  { name: 'authrecovery', file: 'auth-recovery-probe.mjs', timeoutMs: 120000 },
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
// The Schedule view's day grid, the drag-to-reschedule engine, and the recurring series that rolls
// itself forward. They share one probe because they share one file — a drag writes through the same
// occurrence rules a completion does, and splitting them would let the two halves disagree.
{ name: 'calendar', file: 'calendar-probe.mjs', timeoutMs: 180000 },
  // A document is reminded by its expiry, which means a date has to survive a round trip through
  // JSON, a jsonb column and a timezone without moving by a day. Every one of those failure modes
  // looks like a working feature and quietly lies about when something lapses.
  { name: 'documents', file: 'documents-probe.mjs', timeoutMs: 180000 },
  // Money rests on one number. A float creeps in, a total is off by a paisa, and nobody notices for
  // a month. Every check here is one of the ways that happens.
  { name: 'money', file: 'money-probe.mjs', timeoutMs: 180000 },
  // A collection written to but never subscribed to survived for a long time, and so can anything
  // else that merely looks plausible. This is the net for the next one.
  { name: 'deadcode', file: '../../dead-code-audit.mjs', timeoutMs: 60000 },
  // Signing out cleared the Supabase session but left the local state, which one key shared by
  // every account on the device. The next person to sign in inherited it — and the merge pushed
  // it into their account.
  { name: 'signout', file: 'signout-probe.mjs', timeoutMs: 120000 },
  // Parses and shape-checks every file, and runs before the rest so a malformed file is reported
  // as what it is — a broken edit — rather than as a logic failure in whichever suite died on it.
  { name: 'verify', file: 'verify.mjs', timeoutMs: 60000 },
  // Nothing overflowed at any width, so the gap was never a broken layout: the app had breakpoints
  // at 1180/900/480/381/335 and nothing at all for 640px-900px, so a tablet was served the phone
  // layout. Only a measurement across seven widths would have shown it, and nothing measured one.
  { name: 'responsive', file: 'responsive-audit.mjs', timeoutMs: 180000 },
  // Four features that each looked finished and were each one step short of working: a palette
  // that could not be reached by touch, contacts that could not be found, bulk actions the Inbox
  // did not have, and a drag that a native HTML5 drag kept cancelling.
  { name: 'gaps', file: 'ui-gaps-probe.mjs', timeoutMs: 180000 },
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

/* ---------- Pre-flight: parse every file before running anything ----------

   This exists because of how the probe files got corrupted twice. The cause was never the
   content being written — it was *where* it was written. A positional insert lands at a line
   number, blind to what is there, and the line number came from a read that had gone stale. So an
   insert landed inside a `try { ... } finally { ... }`, producing a duplicate `} finally {` and a
   truncated arrow function whose body had swallowed the next `await check(...)`.

   Three things made that expensive rather than obvious:

   - the inserts were batched, so each one moved the target line for the next and the damage
     compounded before anything was looked at;
   - the resulting syntax error was discovered by running a 20-second browser suite, so the first
     symptom looked like a logic failure rather than a broken file;
   - and the same batching hid the fact that a check had been *deleted* by a replacement that was
     meant to insert before it.

   Parsing everything first turns a ten-minute misdiagnosis into a two-second one. `node --check`
   is the same parser Node will use, and it is synchronous and side-effect free, so it is safe to
   run on every file in the repo that this suite can possibly execute. */
function preflightParse() {
  // The app logic is fifteen files in Everything/js, in the order index.html loads them. Reading
  // that order from index.html rather than naming script.js here means a new part is parsed the day
  // it is written, and the failure mode is a two-second "file X does not parse" rather than a suite
  // that quietly stops covering whatever moved.
  const appDir = path.join(here, '..', '..', 'Everything');
  const html = readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const appScripts = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  const targets = [
    ...appScripts.map((rel) => path.join(appDir, rel)),
    path.join(here, 'run-all.mjs'),
    ...SUITES.map((suite) => path.join(here, suite.file)),
  ];
  const broken = [];
  for (const file of targets) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      // The first lines of a Node parse error are a stack trace with no information in them. The
      // useful part is the first line naming a file and a position, so keep that and drop the
      // module-loader noise around it.
      const line = (result.stderr || '')
        .split('\n')
        .map((entry) => entry.trim())
        .find((entry) => /^\S+\.(mjs|js):\d+$/.test(entry));
      const caret = (result.stderr || '').includes('^') ? ' (see the line above for the offending brace)' : '';
      broken.push(`  ${path.relative(path.join(here, '..', '..'), file)}: ${line || 'parse failed'}${caret}`);
    }
  }
  if (broken.length) {
    // ASCII only. A Windows console renders an em dash as mojibake, and a message that is
    // unreadable in the one place it is needed is worse than a plainer one.
    console.log(`\nPARSE ERRORS - these files are malformed, so no result below means anything:\n`);
    console.log(broken.join('\n'));
    console.log('\nUsually an edit that landed in the wrong place. Look for a duplicated block, a');
    console.log('missing closing brace, or a check that was replaced instead of added to.');
    process.exit(1);
  }
}

preflightParse();

for (const suite of selected) {
  process.stdout.write(`${paint('dim', `→ ${suite.name} (${(suite.timeoutMs / 1000) | 0}s budget)`)}\n`);
  const r = await runSuite(suite);

  const pkg = MISSING_MODULE.exec(r.out)?.[1] || (FAILED_TO_START.test(r.out) ? 'its dependency' : null);
  // Each suite prints its own banner, and the wording is not uniform — `ALL 7 AUTO-SAVE CHECKS
  // PASSED` has a hyphen, and `VOICE+IMAGE` has a plus, so the character class has to allow both or
  // the suite is scored as failed while its output plainly says otherwise. That failure mode is
  // the dangerous one: a suite that passes everything is reported as broken, and the real bug goes
  // looking somewhere else.
  const verdict = /ALL (\d+) [A-Z0-9 +&()'’-]*PASSED/.exec(r.out);

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
