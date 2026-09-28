// Finds code that nothing reaches. This exists because a collection that is written to but never
// subscribed to stayed invisible for a long time, and so can anything else that merely looks
// plausible: a function nobody calls, a class nothing applies, a route the client never requests.
//
//   node dead-code-audit.mjs            report only
//   node dead-code-audit.mjs --json     machine-readable
//
// The hard part is not finding unreferenced names, it is not accusing code that IS reached by
// something a grep for a call would miss. So every candidate is reported with the evidence that
// cleared or convicted it, and "used only by tests" is a separate bucket from "used by nobody" —
// a probe that exercises a function is a reason to keep it, not a reason to delete it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(here, p));

const js = read('Everything/script.js');
const html = read('Everything/index.html');
const css = read('Everything/style.css');
const sw = read('Everything/sw.js');

// Everything a name could legitimately be reached from.
const app = [js, html, sw].join('\n');
const testDir = path.join(here, 'Everything', 'tests');
const testSources = fs.existsSync(testDir)
  ? fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(testDir, f), 'utf8'))
  : [];
const tests = testSources.join('\n');

const countOf = (haystack, name) => (haystack.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
const out = { deadFunctions: [], testOnlyFunctions: [], deadClasses: [], deadRoutes: [], brokenScripts: [] };

// ---- functions ---------------------------------------------------------------------------------
// Declaration forms actually used in this file: `function name(`, `async function name(`,
// `const name = (`, and `window.name =`.
const declared = new Map();
for (const m of js.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  declared.set(m[1], (declared.get(m[1]) || 0) + 1);
}
for (const m of js.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
  declared.set(m[1], (declared.get(m[1]) || 0) + 1);
}
// `window.foo = foo` exports are the app's own API surface; the probes drive those by name.
for (const m of js.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) declared.set(m[1], (declared.get(m[1]) || 0) + 1);

for (const [name, defs] of declared) {
  // Declarations themselves are references; anything beyond them is a real use.
  const total = countOf(app, name);
  const inApp = total - defs;
  if (inApp > 0) continue;
  const inTests = countOf(tests, name);
  const row = { name, refs: inApp, totalInApp: total, decls: defs, testRefs: inTests };
  if (inTests > 0) out.testOnlyFunctions.push(row);
  else out.deadFunctions.push(row);
}

// ---- CSS classes -------------------------------------------------------------------------------
// A class counts as live if the markup or script ever names it, or if the stylesheet names it more
// than once (which means it is used in a compound selector, not only declared).
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
  const cls = m[1];
  if (cls in (out._seen || (out._seen = {}))) continue;
  out._seen[cls] = true;
  const inMarkup = new RegExp(`\\b${cls}\\b`).test(html) || new RegExp(`['"\`][^'"\`]*\\b${cls}\\b`).test(js);
  const inCss = countOf(css, cls);
  if (!inMarkup && inCss <= 1) out.deadClasses.push({ cls, inCss });
}
delete out._seen;

// ---- API routes --------------------------------------------------------------------------------
const apiDir = path.join(here, 'Everything', 'api');
const routes = fs.existsSync(apiDir)
  ? fs.readdirSync(apiDir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''))
  : [];
// An operations endpoint is asked for by monitoring, a deploy check or a person with curl — never
// by the page. Flagging it every run would train the reader to ignore this report, which is how a
// real finding gets missed.
const OPS_ONLY = new Set(['health']);
for (const route of routes) {
  if (route === 'vercel' || OPS_ONLY.has(route)) continue;
  // Vercel maps /api/health to api/health.js, so the client must ask for the bare name.
  const asked = new RegExp(`/api/${route}\\b`).test(app) || new RegExp(`['"\`]${route}['"\`]`).test(js);
  if (!asked) out.deadRoutes.push(route);
}

// ---- npm scripts -------------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  for (const m of cmd.matchAll(/(\S+\.(?:mjs|js|json))/g)) {
    if (!exists(m[1])) out.brokenScripts.push({ name, cmd, missing: m[1] });
  }
}

// ---- report ------------------------------------------------------------------------------------
const line = (s) => console.log(s);
if (process.argv.includes('--debug')) {
  // The audit is only worth running if its own counting is sound, so this prints the raw tallies
  // for a handful of names that are definitely live. If these read zero, the audit is lying.
  line('SELF-CHECK — these are called in the app and must not read zero');
  for (const probe of ['requestNotificationPermission', 'renderPeople', 'setThemeConcept', 'renderAll']) {
    const d = declared.get(probe) || 0;
    const total = countOf(app, probe);
    line(`  ${probe.padEnd(30)} decls=${d} totalInApp=${total} uses=${total - d} testRefs=${countOf(tests, probe)}`);
  }
  line(`\n  app source = ${app.length} chars, tests = ${tests.length} chars`);
  process.exit(0);
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const section = (title, rows, fmt) => {
    line(`\n${title}${rows.length ? ` (${rows.length})` : ''}`);
    for (const r of rows) line(`  ${fmt(r)}`);
  };
  section('DEAD FUNCTIONS — declared, referenced nowhere, not even a test', out.deadFunctions,
    (r) => `${r.name}`);
  section('USED ONLY BY TESTS — no call site in the app', out.testOnlyFunctions,
    (r) => `${r.name}  (${r.testRefs} test ref${r.testRefs === 1 ? '' : 's'})`);
  section('DEAD CSS CLASSES — declared once, never named in markup or script', out.deadClasses,
    (r) => `.${r.cls}`);
  section('API ROUTES THE CLIENT NEVER CALLS', out.deadRoutes, (r) => `/api/${r}`);
  section('NPM SCRIPTS POINTING AT MISSING FILES', out.brokenScripts,
    (r) => `${r.name} -> ${r.missing}`);

  const total = out.deadFunctions.length + out.deadClasses.length + out.deadRoutes.length + out.brokenScripts.length;
  if (out.testOnlyFunctions.length) {
    line(`\nKept alive by a probe, not dead: ${out.testOnlyFunctions.map((r) => r.name).join(', ')}`);
  }
  // run-all.mjs scores a suite on this exact banner, so a clean run has to say so in the same
  // dialect as every other suite — otherwise the runner records a green audit as a failure.
  if (!total) line(`\nALL ${out.deadClasses.length + out.deadFunctions.length} DEAD-CODE CHECKS PASSED`);
  else line(`\n${total} finding${total === 1 ? '' : 's'} — dead code reached the app.`);

  // Only real dead code fails the run. A function kept alive by a probe is not dead — that is what
  // the probes are for — so it is reported and tolerated.
  if (total) process.exitCode = 1;
}
