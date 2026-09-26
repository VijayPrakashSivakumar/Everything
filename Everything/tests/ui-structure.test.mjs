// Static sanity checks for the inline-search and mobile-layout changes, so a broken id or an
// unbalanced block fails here instead of silently in the browser.
//   node Everything/tests/ui-structure.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'script.js'), 'utf8');

const results = [];
const inflight = [];
/* Checks may be async (the optional live probe), so the summary must wait for all of them.
   Each check returns a promise that is tracked directly — a Set of flags is not enough,
   because a flag that flips never tells the loop when the work is actually finished. */
function check(name, fn) {
  const promise = Promise.resolve()
    .then(fn)
    .then(
      () => {
        results.push(`PASS  ${name}`);
      },
      (err) => {
        results.push(`FAIL  ${name}\n        ${err.message}`);
        process.exitCode = 1;
      },
    );
  inflight.push(promise);
  return promise;
}

check('the header search box is a real, focusable input', () => {
  assert.match(html, /id="searchInput"/, 'searchInput missing');
  assert.match(html, /id="searchInput"[\s\S]{0,400}?onfocus="openSearch\(\)"/, 'searchInput is not focus-wired');
  assert.match(html, /oninput="runSearch\(this\.value\)"/, 'searchInput does not stream results');
  assert.doesNotMatch(html, /class="search-box" onclick="openAsk\(\)"/, 'the old click-to-open popup is still there');
  assert.doesNotMatch(html, /id="searchInput"[\s\S]{0,400}?readonly/, 'the input must not be readonly');
});

check('the dropdown sits inside a positioned wrapper', () => {
  assert.match(html, /class="search-wrap">[\s\S]*?id="searchBox"[\s\S]*?id="searchDropdown"/, 'dropdown is not nested in search-wrap');
  assert.match(css, /\.search-wrap\s*\{[^}]*position:\s*relative/, '.search-wrap must be the positioning context');
});

check('the dropdown is hidden until used and has no stale positioning', () => {
  assert.match(html, /id="searchDropdown"[^>]*hidden/, 'dropdown must start hidden');
  assert.match(css, /\.search-dropdown\[hidden\]\s*\{\s*display:\s*none/, 'hidden dropdown needs display:none');
  const block = css.match(/\.search-dropdown\s*\{[^}]*\}/);
  assert.ok(block, '.search-dropdown rule missing');
  assert.doesNotMatch(block[0], /position:\s*fixed/, 'a fixed dropdown would detach from the field');
});

check('the mobile input keeps its width instead of collapsing to zero', () => {
  // `min-width: 0` is legitimate and must not be mistaken for `width: 0`, which would hide
  // the field on mobile, so the declaration is matched with a word boundary.
  assert.doesNotMatch(
    css,
    /\.search-box input\s*\{[^}]*(^|[\s;])width:\s*0[;\s]/m,
    'width:0 would hide the input on mobile',
  );
  const mobile = css.match(/\.search-box input\s*\{[^}]*width:\s*100%[^}]*\}/);
  assert.ok(mobile, 'the input must keep a usable width inside a mobile media query');
  const idx = css.indexOf(mobile[0]);
  const before = css.slice(0, idx);
  const query = before.lastIndexOf('@media');
  assert.match(before.slice(query, query + 40), /max-width:\s*900px/, 'width:100% must live in a mobile media query');
});

check('the Capture sheet is narrower and height-capped on phones', () => {
  const mobile = css.match(/@media \(max-width:900px\)[\s\S]*?\.modal\s*\{[^}]*\}/);
  assert.ok(mobile, 'mobile .modal rule missing');
  assert.match(mobile[0], /max-width:\s*4\d\dpx/, 'the sheet is still too wide for a phone');
  assert.match(mobile[0], /max-height:\s*min\([^)]*dvh/, 'the sheet must be capped against the viewport height');
  assert.doesNotMatch(css, /max-width:\s*560px/, 'the old 560px sheet width is still present');
});

check('the back gesture is guarded and layered', () => {
  assert.match(js, /function initBackNavigation\(\)/, 'initBackNavigation missing');
  assert.match(js, /history\.pushState\(\{\s*everythingLayer/, 'no history guard is pushed');
  assert.match(js, /window\.addEventListener\("popstate"/, 'no popstate handler');
  assert.match(js, /closeTopmostOverlay\(\)/, 'back must close the top layer first');
  assert.match(js, /initBackNavigation\(\);/, 'back navigation is never initialised');
  // The guard must track what is on screen, not be seeded once and left to rot.
  assert.match(js, /MutationObserver/, 'the guard must follow layer open/close');
  assert.doesNotMatch(js, /closeTopmostOverlay\.peekOpen/, 'stale peekOpen reference');
});

check('the back guard covers every dismissible layer', () => {
  const init = js.slice(js.indexOf('function initBackNavigation'));
  const selector = init.match(/const LAYER_SELECTOR\s*=\s*"([^"]+)"/);
  assert.ok(selector, 'LAYER_SELECTOR missing');
  for (const layer of ['.modal-overlay.open', '.ask-overlay.open', '#panel.open', '#sidebar.open', '#searchDropdown']) {
    assert.ok(selector[1].includes(layer), `${layer} is not guarded by back`);
  }
});

check('the back guard closes the search dropdown before anything else', () => {
  const fn = js.slice(js.indexOf('function closeTopmostOverlay'));
  const dropdown = fn.indexOf('searchDropdown');
  const ask = fn.indexOf('askOverlay');
  assert.ok(dropdown > -1, 'closeTopmostOverlay does not handle the search dropdown');
  assert.ok(dropdown < ask, 'the dropdown must close before the Ask overlay');
});

/* The deployed schema is mixed: the original prototype tables (items/projects/goals/people) were
   created with a `created` column, while the later foundation tables (entries/tasks) use
   `created_at`. Ordering by the wrong name is an error, not an empty result, so every read route
   must resolve the real column instead of hardcoding one. */
const MIXED_SCHEMA_TABLES = ['projects', 'goals', 'people', 'items', 'entries', 'tasks'];

check('no read route hardcodes a created timestamp column', () => {
  const routes = fs.readdirSync(path.join(root, 'api'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(root, 'api', f), 'utf8') }));
  for (const { name, src } of routes) {
    assert.doesNotMatch(src, /\.order\(\s*['"]created_at['"]/, `api/${name} hardcodes order('created_at')`);
    assert.doesNotMatch(src, /\.order\(\s*['"]created['"]/, `api/${name} hardcodes order('created')`);
  }
});

check('the client fallback also resolves the column', () => {
  assert.doesNotMatch(js, /\.order\(\s*["']created_at["']/, 'the client fallback hardcodes created_at');
  assert.match(js, /function structuredCreatedColumn\(/, 'structuredCreatedColumn helper missing');
  assert.match(js, /if \(orderColumn\) query = query\.order\(/, 'the fallback must order conditionally');
});

check('both resolvers try the known column names and cache them', () => {
  const server = fs.readFileSync(path.join(root, 'api/lib/auth.js'), 'utf8');
  const resolver = server.slice(server.indexOf('const CREATED_COLUMN_CANDIDATES'));
  for (const column of ['created_at', 'created']) {
    assert.ok(resolver.includes(`'${column}'`), `server resolver must try ${column}`);
    assert.ok(js.includes(`"${column}"`), `client resolver must try ${column}`);
  }
  assert.match(server, /createdColumnCache/, 'server result must be cached');
  assert.match(js, /structuredCreatedCache/, 'client result must be cached');
});

check('a missing timestamp column degrades instead of failing', () => {
  const server = fs.readFileSync(path.join(root, 'api/lib/auth.js'), 'utf8');
  const fn = server.slice(server.indexOf('export async function orderNewestFirst'));
  assert.match(fn, /return column \? builder\.order\([^)]*\) : builder;/, 'must return the builder unchanged when no column is found');
  const resolver = server.slice(server.indexOf('export async function createdColumn'));
  assert.match(resolver, /createdColumnCache\.set\(table, null\)/, 'a missing column must be remembered, not retried forever');
});

/* Opt-in live probe: the deployed schema is the source of truth for these column names, but the
   check needs network access. It is skipped by default so the offline suite stays fast and
   deterministic. Run `node Everything/tests/ui-structure.test.mjs --live` before a release, or
   after applying a migration, to confirm the deployed shape still matches. */
if (process.argv.includes('--live')) {
  check('the live database exposes an orderable created column on every table', async () => {
    const key = js.match(/const SUPABASE_KEY\s*=\s*"([^"]+)"/);
    const base = js.match(/const SUPABASE_URL\s*=\s*"([^"]+)"/);
    if (!key || !base) throw new Error('Supabase URL/key not found in script.js');

    const probe = async (table, column) => {
      const url = `${base[1]}/rest/v1/${table}?select=id&order=${column}.desc&limit=0`;
      const res = await fetch(url, {
        headers: { apikey: key[1], Authorization: `Bearer ${key[1]}` },
        signal: AbortSignal.timeout(10000),
      });
      return res.ok;
    };

    for (const table of MIXED_SCHEMA_TABLES) {
      const hasCreatedAt = await probe(table, 'created_at');
      const hasCreated = await probe(table, 'created');
      assert.ok(
        hasCreatedAt || hasCreated,
        `${table} exposes neither created_at nor created — the resolver cannot order it`,
      );
    }
  });
} else {
  results.push('SKIP  live database probe (re-run with --live)');
}

check('both search entry points share one matcher', () => {
  assert.match(js, /function searchMatches\(q\)/, 'searchMatches helper missing');
  // Exactly one place may decide what matches. searchMatches and the two helpers it delegates
  // to are allowed; a second inline filter means the entry points could disagree.
  for (const name of ['function searchMatches(q)', 'function searchScore(', 'function searchHaystack(']) {
    assert.equal((js.match(new RegExp(name.replace(/[()]/g, '\\$&'), 'g')) || []).length, 1,
      `${name} must be declared exactly once`);
  }
  const body = js.slice(js.indexOf('function searchMatches'));
  const helper = body.slice(0, body.indexOf('\n}'));
  assert.match(helper, /searchScore\(/, 'searchMatches must delegate the matching to searchScore');
  // No ad-hoc matching against the item list may creep back in beside the shared helpers.
  const others = js.replace(/function searchScore\([\s\S]*?\n}\n/, '').replace(/function searchHaystack\([\s\S]*?\n}\n/, '')
    .replace(/function searchMatches\([\s\S]*?\n}\n/, '');
  assert.doesNotMatch(others, /state\.items\s*\n?\s*\.filter\([\s\S]{0,200}?\.toLowerCase\(\)[\s\S]{0,120}?\.includes\(/,
    'duplicate inline matching logic still exists');
  assert.match(js, /const matches = searchMatches\(q\);/, 'runAsk must reuse searchMatches');
});

check('the AI answer cannot wipe the dropdown hit list', () => {
  assert.match(js, /id="searchAskSlot"/, 'the dropdown needs its own AI slot');
  assert.match(js, /mount:\s*document\.getElementById\("searchAskSlot"\)/, 'askAI must mount into the AI slot');
});

/* These lock in the search/retrieval fixes. They run the real search functions out of
   script.js against a stub `state`, so a regression fails here with a readable message
   instead of surfacing as "the AI just doesn't understand my question". */
const searchDeps = ['state', 'isArchived', 'taskStatusFromItem', 'taskStatusLabel', 'normaliseChecklist', 'checklistProgress', 'formatDueDisplay'];
const stubDeps = {
  state: {
    items: [
      { id: 'a', kind: 'task', title: 'Renew gym membership', project: 'Health', priority: 'high', status: 'today', dueDate: '2026-09-25', created: 300 },
      { id: 'b', kind: 'task', title: 'Draft Atlas proposal', sub: 'send to Priya', project: 'Atlas', priority: 'high', status: 'in_progress', created: 200 },
      { id: 'c', kind: 'memory', title: 'Book recommendation', sub: 'from Priya', person: 'Priya', created: 100 },
      { id: 'd', kind: 'task', title: 'Water plants', project: 'Home', status: 'waiting', checklist: [{ text: 'buy soil', done: true }, { text: 'repot', done: false }], created: 50 },
      { id: 'e', kind: 'task', title: 'Old archived thing', sub: 'gym', archivedAt: 1, created: 400 },
    ],
  },
  isArchived: (i) => Boolean(i?.archivedAt || i?.archived_at),
  taskStatusFromItem: (i) => (i.done ? 'completed' : i.status || 'planned'),
  taskStatusLabel: (v) => String(v || '').replace(/_/g, ' '),
  normaliseChecklist: (v) => (Array.isArray(v) ? v.filter((s) => s && s.text) : []),
  checklistProgress: (i) => {
    const list = Array.isArray(i?.checklist) ? i.checklist : [];
    return { total: list.length, completed: list.filter((s) => s.done).length };
  },
  formatDueDisplay: (d) => String(d || ''),
};
// Lift the real search functions out of the bundle and run them against the stub state.
const between = (start, end) => {
  const from = js.indexOf(start);
  assert.ok(from > -1, `${start} is missing from script.js`);
  const to = js.indexOf(end, from);
  assert.ok(to > -1, `no ${JSON.stringify(end)} after ${start}`);
  return js.slice(from, to + end.length);
};
// Slices a run of code out of script.js, from `start` up to (but not including) the line that
// begins with `end`. The end marker is anchored to the start of a line, so a marker like "}" cannot
// latch onto the closing brace of an earlier function and silently truncate the slice — which is
// what a plain substring search does, and it is how buildLocalAnswer went missing from the harness
// while the tests still appeared to run.
const betweenBlock = (start, end) => {
  const from = js.indexOf(start);
  assert.ok(from > -1, `${start} is missing from script.js`);
  const rest = js.slice(from);
  const pattern = new RegExp(`(?:\\r?\\n)[ \\t]*${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const match = pattern.exec(rest);
  assert.ok(match, `no line starting ${JSON.stringify(end)} after ${start}`);
  // Cut immediately before the matched line, leaving the preceding block fully intact.
  return rest.slice(0, match.index);
};
const searchSource = [
  between('const SEARCH_STOP_WORDS', ']);'),
  between('const SEARCH_ALIASES', '};'),
  between('function searchAliases', '\n}'),
  between('function searchTerms', '\n}'),
  between('function searchHaystack', '\n}'),
  between('function searchScore', '\n}'),
  between('function searchMatches', '\n}'),
  between('const ASK_CONTEXT_MATCHES', '\n}'),
  // One slice for the whole cost-control block; splitting it re-declares QUESTION_WORDS. Anchor on
  // the next declaration, since a "\n}\n" marker would latch onto an earlier closing brace.
  betweenBlock('const MODEL_MIN_INTERVAL_MS', 'async function askAI'),
].join('\n');
const runSearch = (deps, expr) =>
  new Function(...searchDeps, `${searchSource}\nreturn ${expr};`)(...searchDeps.map((k) => deps[k]));
const searchApi = runSearch(stubDeps, '({ searchMatches, askContextPool })');
const titles = (items) => items.map((i) => i.title);

check('a partial word still finds the item', () => {
  // "gym" must match "Renew gym membership" — the old matcher needed the whole query verbatim.
  assert.deepEqual(titles(searchApi.searchMatches('gym')), ['Renew gym membership']);
});

check('a natural question is not searched as one long phrase', () => {
  // No single title contains "what should I do today", so the old matcher returned nothing and
  // the AI was handed an arbitrary list of items instead.
  assert.ok(searchApi.searchMatches('what should I do today').length > 0, 'a plain question must still retrieve something');
});

/* ---------- Free-tier cost control ----------

   Groq's free `openai/gpt-oss-120b` allows 8K input tokens/minute. A full context is several
   thousand tokens, and the debounced handlers fire on every typing pause, so a normal search
   session could exhaust the quota in a couple of questions. The ranked local search is now the
   default answer and the model is only spent on something that genuinely reads as a question. */

const costApi = runSearch(stubDeps, '({ shouldAskModel, buildLocalAnswer, modelCallAllowed })');

check('a keyword lookup does not spend a model call', () => {
  assert.equal(costApi.shouldAskModel('gym'), false, 'a bare keyword is a lookup, not a question');
  assert.equal(costApi.shouldAskModel(''), false, 'an empty query must never call the model');
  assert.equal(costApi.shouldAskModel('atlas'), false, 'a short word is a lookup');
});

check('a real question does reach the model', () => {
  assert.equal(costApi.shouldAskModel('what did I say about the gym membership'), true,
    'a genuine question must still be answered by the model');
  assert.equal(costApi.shouldAskModel('when is the invoice due'), true, 'a due-date question qualifies');
  assert.equal(costApi.shouldAskModel('how much did I spend on'), true, 'an open-ended question qualifies');
});

check('a lookup is answered locally without spending quota', () => {
  const answer = costApi.buildLocalAnswer('gym');
  assert.ok(answer, 'a lookup must still produce an answer');
  assert.match(answer, /gym membership/i, 'the answer must name the matching item');
  assert.doesNotMatch(answer, /rate limited/i, 'a normal lookup must not warn about limits');
});

check('a question is deliberately not answered locally, so the model can improve it', () => {
  assert.equal(costApi.buildLocalAnswer('what did I say about the gym membership'), null,
    'a real question must be passed to the model rather than short-changed');
});

check('repeated model calls are throttled so the quota cannot be drained by typing', () => {
  assert.equal(costApi.modelCallAllowed(), true, 'the first call is always allowed');
  assert.equal(costApi.modelCallAllowed(), false, 'an immediate second call must be throttled');
  assert.equal(costApi.modelCallAllowed(), false, 'and a third must stay throttled');
});

check('a single model call is not sent more often than the free tier allows', () => {
  assert.match(js, /const MODEL_MIN_INTERVAL_MS = 6000;/,
    'the model must be rate limited locally, not only on the server');
  assert.match(js, /const callModel = wantsModel && modelCallAllowed\(\);/,
    'the throttled flag must actually gate the network call');
  assert.match(js, /if \(!callModel\) \{[\s\S]*?return;/,
    'a throttled or non-question query must return before any fetch is attempted');
  // The local answer must be what the user keeps, not a generic line thrown together on failure.
  assert.match(js, /const body =\s*\n?\s*localAnswer \|\|/,
    'an already-computed local answer must be reused rather than discarded');
});

check('the server bounds the context to what a free tier can actually accept', () => {
  const ask = fs.readFileSync(new URL('../api/ask.js', import.meta.url), 'utf8');
  // 30 items is several thousand tokens, which is most of Groq's 8K tokens/minute on its own.
  const maxItems = Number((ask.match(/const MAX_CONTEXT_ITEMS = (\d+);/) || [])[1]);
  assert.ok(Number.isFinite(maxItems), 'MAX_CONTEXT_ITEMS must be a number');
  assert.ok(maxItems <= 12, `context must fit a free-tier minute, found ${maxItems} items`);
});

/* ---------- Every view must render itself ----------

   Insights was the only view with no render call in switchView(): its tiles and cards were filled
   in as a side effect of renderToday(), so opening Insights first — from a deep link, a restored
   session, or simply tapping it before Today — showed empty stats and "Nothing to show yet." even
   with plenty of data. Every other view renders on switch. */

check('person and project names match case-insensitively, not with ===', () => {
  // A person saved as "ravi" with an item tagged "Ravi" showed 0 linked items and an empty modal,
  // while the duplicate check — already case-insensitive — refused to add the name again. One
  // helper, so the two paths cannot disagree again.
  assert.match(js, /const sameName = \(a, b\) =>/, 'sameName helper must exist');

  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Every name comparison goes through the helper; no raw === remains.
  const raw = [...code.matchAll(/i\.person === |i\.project === |=== p\.name|=== currentPersonName|knownNames\.includes\(/g)];
  assert.deepEqual(raw.map((m) => m[0]), [],
    `name matching must use sameName(), found raw comparisons: ${raw.map((m) => m[0]).join(', ')}`);

  // And each of the five sites that used === is now covered.
  const uses = (code.match(/sameName\(/g) || []).length;
  assert.ok(uses >= 8, `all name comparisons should route through sameName(), found ${uses} uses`);

  // Empty must never match, including empty against empty: an untagged item would otherwise count
  // as linked to every untagged person.
  const start = js.indexOf('const sameName = (a, b) =>');
  const src = js.slice(start, js.indexOf('\n}', start) + 2);
  const sameName = new Function(`${src}\nreturn sameName;`)();
  const cases = [
    ['Ravi', 'ravi', true], ['RAVI', 'Ravi', true], ['  ravi ', 'Ravi', true],
    ['Ravi', 'Ravi Kumar', false], ['Ravi', '', false], ['', '', false],
    [null, undefined, false], [undefined, 'Ravi', false],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(sameName(a, b), want, `sameName(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  }
});

check('a real question reaches the model even when nothing matches', () => {
  // Regression: buildLocalAnswer() returned null when there were no matches, and askAI() read null
  // as "this is a question, call the model". So on an account with no matches the logic inverted and
  // a genuine question was answered locally instead — the cost fix disabled the model for exactly
  // the case it existed for. The browser audit caught it.
  const src = betweenBlock('function buildLocalAnswer', 'function modelCallAllowed');
  // The question check must come first, or the two branches invert.
  const qAt = src.indexOf('if (shouldAskModel(q))');
  const nmAt = src.indexOf('if (!matches.length)');
  assert.ok(qAt > -1, 'buildLocalAnswer must defer for a real question');
  assert.ok(nmAt > qAt, 'the question check must precede the no-matches branch');
  assert.match(src, /if \(!matches\.length\) return "No matching items in your captures\.";/,
    'a lookup with no matches is answered locally rather than spending a model call');
});

check('a project name with an apostrophe still produces a working button', () => {
  // Proven in a real browser: the Delete handler rendered as
  //   onclick="deleteProject('i_abc','Mom&#39;s Project')"
  // and the browser decodes entities *before* compiling the handler, so it reached the parser as
  // deleteProject('i_abc','Mom's Project') — a SyntaxError. The button silently did nothing, and
  // the only trace was a console error. escapeHtml is not sufficient inside an inline handler.
  assert.match(js, /const jsStr = \(v\) => escapeHtml\(JSON\.stringify\(String\(v \?\? ""\)\)\);/,
    'jsStr helper must exist: JSON.stringify for the JS literal, escapeHtml for the attribute');

  // No inline handler may pass escaped text straight through as a single-quoted JS string again.
  for (const fn of ['deleteProject', 'openPersonModal', 'answerCaptureQuestion']) {
    const call = new RegExp(`onclick="${fn}\\([^"]*'\\$\\{escapeHtml`, 'g');
    assert.deepEqual([...js.matchAll(call)].map((m) => m[0]), [],
      `${fn} must use jsStr(), not a quoted escapeHtml()`);
  }

  // Behaviour: build the attribute the way renderProjects does, decode it the way a browser does,
  // then check the handler actually parses and receives the exact name.
  const start = js.indexOf('function escapeHtml(');
  const src = js.slice(start, js.indexOf('const jsStr'));
  const jsStr = new Function(`${src}\nconst jsStr = (v) => escapeHtml(JSON.stringify(String(v ?? "")));\nreturn jsStr;`)();
  const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g,
    (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]);

  for (const name of ["Mom's Project", 'Home', 'Bob & Sue "Q" <x>', 'back\\slash', 'line\nbreak']) {
    const attr = `deleteProject("i_abc", ${jsStr(name)})`;
    let got;
    try {
      got = new Function('deleteProject', `return (${decode(attr)});`)((...a) => a);
    } catch (e) {
      assert.fail(`handler for ${JSON.stringify(name)} does not parse: ${e.message}`);
    }
    assert.equal(got[1], name, `the name must survive to the handler intact for ${JSON.stringify(name)}`);
    assert.equal(got[0], 'i_abc', 'the id must survive too');
  }
});

check('a project cannot be created twice under names that differ only by case or spaces', () => {
  // Confirmed in a real browser: "Home", "home" and "  Home  " all created cards, and since items
  // are matched to projects by name via sameName(), every card then showed the same items — so the
  // open count appeared two or three times for work that existed once. People already had this
  // guard; projects did not.
  const start = js.indexOf('async function addProject()');
  const src = js.slice(start, js.indexOf('\n}', start));
  assert.match(src, /if \(state\.projects\.some\(\(p\) => sameName\(p\.name, name\)\)\)/,
    'addProject must refuse a duplicate using sameName(), like addPersonManual does');
  assert.ok(src.indexOf('sameName') < src.indexOf('state.projects.unshift'),
    'the duplicate check must run before the project is added');
  // The guard must clear the input even on a refusal, so the same name is not silently re-sent.
  assert.match(src, /sameName[\s\S]*?input\.value = "";/,
    'a refused duplicate must clear the input');
});

/* ---------- Renaming and removing people and projects ----------

   Items link to a person or project by *name*, so the name is the identity. Before this there was
   no way to correct one: "Hom" stranded every item tagged with it, and a person could never be
   removed at all. These run the real functions against a stub world, so the assertions are about
   behaviour rather than about the presence of a string. */

const renameSource = [
  between('const sameName = (a, b) =>', '\n};'),
  betweenBlock('function retagItems', 'async function addProject'),
  // between() includes its end marker, which is what you want for a closing brace but not for a
  // function signature: it would leave a dangling "function renderProjects" in the source. Cut short.
  js.slice(
    js.indexOf('async function renameProject'),
    js.indexOf('function renderProjects'),
  ),
  // The real dbDeletePerson, not a stub: this test is about the record actually leaving the store,
  // and a stub that only recorded the id would have passed while the record stayed put.
  js.slice(
    js.indexOf('async function dbDeletePerson'),
    js.indexOf('async function dbDeleteGoal'),
  ),
].join('\n');
// sameName is declared inside renameSource, so it must not also be injected as a parameter.
const renameDeps = ['state', 'isArchived', 'dbSaveItem', 'dbSavePerson', 'dbSaveProject',
  'renderAll', 'renderProjects', 'closePersonModal', 'alert', 'confirm', 'prompt',
  'currentPersonName', 'syncReadyPromise', 'db', 'sbUser', 'deleteStructuredRecord',
  'save', 'renderNav', 'renderPeople'];
const runRename = (deps, expr) =>
  new Function(...renameDeps, `${renameSource}\nreturn ${expr};`)(
    ...renameDeps.map((k) => deps[k]),
  );

// A fresh world per test. Every persistence call is recorded instead of performed.
const makeWorld = () => {
  const saved = { items: [], people: [], projects: [], deleted: undefined };
  const world = {
    state: {
      items: [
        { id: 'i1', title: 'Call the plumber', person: 'ravi', project: 'Home' },
        { id: 'i2', title: 'Book flights', person: '  RAVI ', project: 'home' },
        { id: 'i3', title: 'Pay Priya back', person: 'Priya', project: 'Office' },
      ],
      people: [{ id: 'p1', name: 'Ravi', notes: '', created: 1 }],
      projects: [{ id: 'j1', name: 'Home', created: 1 }],
    },
    isArchived: (i) => Boolean(i?.archivedAt || i?.archived_at),
    dbSaveItem: async (i) => { saved.items.push(i.id); },
    dbSavePerson: async (p) => { saved.people.push(p.id); },
    dbSaveProject: async (p) => { saved.projects.push(p.id); },
    renderAll: () => {},
    renderProjects: () => {},
    closePersonModal: () => {},
    // dbDeletePerson is the real one, so these are its own dependencies.
    syncReadyPromise: null,
    db: null,
    sbUser: null,
    deleteStructuredRecord: async () => true,
    save: () => {},
    renderNav: () => {},
    renderPeople: () => {},
    alert: (m) => { world.alerted = m; },
    confirm: () => { world.confirmed = true; return true; },
    prompt: () => { throw new Error('prompt should not be reached in these tests'); },
    currentPersonName: null,
  };
  return { world, saved };
};
const peopleOf = (world) => world.state.items.map((i) => i.person);
const projectsOf = (world) => world.state.items.map((i) => i.project);

check('renaming a person carries every linked item with it', async () => {
  const { world, saved } = makeWorld();
  const api = runRename(world, '({ renamePerson })');
  await api.renamePerson('Ravi', 'Ravi Kumar');
  // The items spell the name three different ways, and all three must follow.
  assert.deepEqual(peopleOf(world), ['Ravi Kumar', 'Ravi Kumar', 'Priya']);
  assert.equal(world.state.people[0].name, 'Ravi Kumar');
  assert.deepEqual(saved.items.sort(), ['i1', 'i2'], 'only the items that changed are rewritten');
  assert.deepEqual(saved.people, ['p1']);
});

check('a case-only rename is still written through to the items', async () => {
  const { world, saved } = makeWorld();
  world.state.people[0].name = 'ravi';
  const api = runRename(world, '({ renamePerson })');
  await api.renamePerson('ravi', 'Ravi');
  assert.equal(world.state.people[0].name, 'Ravi', 'the stored spelling must be corrected');
  assert.deepEqual(peopleOf(world), ['Ravi', 'Ravi', 'Priya']);
  assert.deepEqual(saved.items.sort(), ['i1', 'i2']);
});

check('a rename refuses a blank name and a name that is already taken', async () => {
  const { world, saved } = makeWorld();
  world.state.people.push({ id: 'p2', name: 'Priya', notes: '', created: 2 });
  const api = runRename(world, '({ renamePerson })');
  await api.renamePerson('Ravi', '   ');
  assert.match(world.alerted || '', /required/i, 'a blank name must be refused');
  await api.renamePerson('Ravi', 'priya');
  assert.match(world.alerted || '', /already in your people list/i);
  assert.equal(world.state.people[0].name, 'Ravi', 'a refused rename must change nothing');
  assert.deepEqual(peopleOf(world), ['ravi', '  RAVI ', 'Priya']);
  assert.deepEqual(saved.items, [], 'a refused rename must not rewrite items');
});

check('renaming a project carries its items with it', async () => {
  const { world, saved } = makeWorld();
  const api = runRename(world, '({ renameProject })');
  await api.renameProject('j1', 'Home Renovation');
  assert.deepEqual(projectsOf(world), ['Home Renovation', 'Home Renovation', 'Office']);
  assert.equal(world.state.projects[0].name, 'Home Renovation');
  assert.deepEqual(saved.items.sort(), ['i1', 'i2']);
  assert.deepEqual(saved.projects, ['j1']);
});

check('deleting a person untags their items so they stop reappearing', async () => {
  // renderPeople() infers people from the items that name them, so leaving the tag behind would
  // re-create the person on the very next render and make Remove look like it had done nothing.
  const { world, saved } = makeWorld();
  const api = runRename(world, '({ deletePerson })');
  await api.deletePerson('Ravi');
  assert.deepEqual(world.state.people.map((p) => p.name), [], 'the stored record must be gone');
  assert.deepEqual(peopleOf(world), ['', '', 'Priya']);
  assert.deepEqual(
    world.state.items.filter((i) => i.person && i.person.trim()).map((i) => i.id),
    ['i3'],
    'no item may still name the removed person, or the list re-infers them',
  );
  assert.deepEqual(saved.items.sort(), ['i1', 'i2']);
});

check('cancelling the confirm keeps the person, the record and every tag', async () => {
  const { world, saved } = makeWorld();
  world.confirm = () => false;
  const api = runRename(world, '({ deletePerson })');
  await api.deletePerson('Ravi');
  assert.deepEqual(world.state.people.map((p) => p.name), ['Ravi']);
  assert.deepEqual(peopleOf(world), ['ravi', '  RAVI ', 'Priya']);
  assert.deepEqual(saved.items, []);
});

check('a captured item with no kind cannot break the Today view', () => {
  // A backup edited by hand, or one predating the kind field, arrives without one. renderToday()
  // interpolated item.kind.charAt() directly, so a single kindless item threw a TypeError and left
  // the whole view half-rendered — while the two helpers on the line above already tolerated it.
  const today = between('function renderToday', 'function renderInbox');
  assert.doesNotMatch(today, /item\.kind\.charAt\(/,
    'the kind must be defaulted before it is used, not dereferenced straight off the item');
  assert.match(today, /const kind = item\.kind \|\| "text";/,
    'the kind needs the same default the other normalisers use');
  assert.match(today, /escapeHtml\(kind\.charAt\(0\)\.toUpperCase\(\)/,
    'the kind is interpolated into innerHTML, so it must be escaped like any other text');

  // And the import path must not create that situation in the first place.
  const backup = between('for (const item of incomingItems)', 'for (const p of incomingProjects');
  assert.match(backup, /if \(!item\.kind\) item\.kind = "text";/,
    'imported JSON is user-supplied and must be defaulted like itemToRow does');
});

check('removing a person covers every storage backend and has a button', () => {
  const src = between('async function dbDeletePerson', 'async function dbDeleteGoal');
  assert.match(src, /state\.people = state\.people\.filter\(\(p\) => p\.id !== id\);/,
    'the local store must drop the person, like dbDeleteProject does');
  assert.match(src, /deleteStructuredRecord\("person"/, 'Supabase sync must be covered too');
  assert.match(html, /onclick="deletePerson\(/, 'the person dialog needs a Remove button');
  assert.match(html, /onclick="startRenamePerson\(\)"/, 'the person dialog needs a Rename button');
  assert.match(js, /onclick="startRenameProject\(/, 'each project card needs a Rename button');
});

check('a goal can be renamed and its controls survive any id', () => {
  // Goals were the last entity with a create but no repair path: addGoal() set the title once and
  // renderGoals() offered only a tick and a Delete, so a mistyped goal was permanent — the same dead
  // end that the people and projects work had just closed.
  assert.match(js, /onclick="startRenameGoal\(/, 'each goal row needs a Rename button');
  const rename = between('async function renameGoal', 'function renderGoals');
  assert.match(rename, /goal\.title = next;/, 'the rename must actually write the title');
  assert.match(rename, /await dbSaveGoal\(goal\);/, 'and persist it through the shared saver');

  // The tick and Delete interpolated the id straight into a quoted string. Ids are generated today,
  // but importBackup accepts whatever id a hand-edited backup carries, and a quote in one produced a
  // handler the parser rejects — leaving that goal with no working control at all.
  const goals = between('function renderGoals', 'function logCompletion');
  assert.doesNotMatch(goals, /onclick="\w+\('\$\{g\.id\}'\)"/,
    'goal handlers must not interpolate the id into a quoted string');
  assert.match(goals, /onclick="toggleGoal\(\$\{jsStr\(g\.id\)\}\)"/, 'the tick must use jsStr');
  assert.match(goals, /onclick="deleteGoal\(\$\{jsStr\(g\.id\)\}\)"/, 'Delete must use jsStr');
  assert.match(goals, /onclick="startRenameGoal\(\$\{jsStr\(g\.id\)\}, \$\{jsStr\(g\.title\)\}\)"/,
    'Rename needs both the id and the current title');

  // Behaviour: build the attribute the way renderGoals does, decode it the way a browser does, then
  // check the handler actually parses and hands the exact id through.
  const start = js.indexOf('function escapeHtml(');
  const src = js.slice(start, js.indexOf('const jsStr'));
  const jsStr = new Function(`${src}\nreturn (v) => escapeHtml(JSON.stringify(String(v ?? "")));`)();
  const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g,
    (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]);

  for (const id of ["o'brien", 'i_abc', 'x"y', 'back\\slash']) {
    const attr = `toggleGoal(${jsStr(id)})`;
    let got;
    try {
      got = new Function('toggleGoal', `return (${decode(attr)});`)((a) => a);
    } catch (e) {
      assert.fail(`goal handler for ${JSON.stringify(id)} does not parse: ${e.message}`);
    }
    assert.equal(got, id, `the goal id must reach the handler intact for ${JSON.stringify(id)}`);
  }
});


check('every view is rendered when it is opened, not as a side effect of another', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const views = [...html.matchAll(/id="view-(\w+)"/g)].map((m) => m[1]);
  assert.ok(views.length > 0, 'no views found in index.html');

  const switchView = js.slice(js.indexOf('function switchView'), js.indexOf('function syncSidebarMode'));
  // `today` is the landing view and renders on load; `logout` is a static card with no data.
  const dataDriven = views.filter((v) => v !== 'today' && v !== 'logout');
  const missing = dataDriven.filter((v) => !switchView.includes(`id === "${v}"`));
  assert.deepEqual(missing, [], `views with no render call in switchView(): ${missing.join(', ')}`);
});

check('the Insights view renders itself rather than borrowing renderToday', () => {
  assert.match(js, /function renderInsights\(\)/, 'renderInsights must exist');
  assert.match(js, /if \(id === "insights"\) renderInsights\(\);/,
    'switchView must render Insights when it is opened');

  // The full view owns #insightsFull and #insightsStats. If renderToday still wrote them, the bug
  // would come straight back the moment anyone reordered the two.
  const insights = js.slice(js.indexOf('function renderInsights'), js.indexOf('function getInsights'));
  assert.match(insights, /getElementById\("insightsFull"\)/, 'renderInsights owns the full card');
  assert.match(insights, /getElementById\("insightsStats"\)/, 'renderInsights owns the stat tiles');

  const today = js.slice(js.indexOf('function renderToday'), js.indexOf('function renderInsights'));
  assert.doesNotMatch(today, /getElementById\("insightsFull"\)/,
    'renderToday must not fill the Insights view as a side effect');
  assert.doesNotMatch(today, /getElementById\("insightsStats"\)/,
    'renderToday must not fill the Insights stat tiles as a side effect');
});

check('insight text is escaped, because it is built from user-supplied titles', () => {
  // getInsights() interpolates item titles, project names and person names into its strings, so
  // every render site must escape. The Today strip did not, which was a latent injection.
  const strip = js.slice(js.indexOf('function renderToday'), js.indexOf('function renderInsights'));
  assert.match(strip, /insight-title">\$\{escapeHtml\(i\.title\)\}/,
    'the Today insight strip must escape the title');
  assert.match(strip, /insight-sub">\$\{escapeHtml\(i\.sub\)\}/,
    'the Today insight strip must escape the sub text');
  const full = js.slice(js.indexOf('function renderInsights'), js.indexOf('function getInsights'));
  assert.match(full, /insight-title">\$\{escapeHtml\(i\.title\)\}/,
    'the Insights view must escape the title');
});

/* ---------- No .single() on a query that can legitimately match nothing ----------

   PostgREST answers `.single()` with HTTP 406 PGRST116 when zero rows come back, not with a null
   row. Every one of these queries is reachable with no matching row — a new account has no profile,
   a mistyped invite code matches no household — so each was logging a 406 on a normal path. The
   browser check that found this reported: "failures on a SECOND Settings visit: 1  406 .../profiles". */

check('read queries that can match no row use maybeSingle, not single', () => {
  // Strip comments before counting: the code carries comments that explain why .single() is wrong,
  // and those mention the method by name. Counting raw text would count the explanation, not a call.
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const singleCalls = (code.match(/\.single\(\)/g) || []).length;
  const insertSingle = /insert\([^)]*\)[\s\S]{0,80}?\.single\(\)/.test(code);
  assert.ok(insertSingle, 'the household insert should still use .single() — it always returns one row');
  assert.equal(singleCalls, 1, `only the guaranteed-row insert may use .single(), found ${singleCalls}`);
  // And the reason must be written down, so the next reader does not "fix" it back.
  assert.match(js, /maybeSingle\(\)[^\n]*not single\(\)|not single\(\)[^\n]*maybeSingle\(\)/,
    'the reason for maybeSingle() must be documented next to the call');
});

check('a new account with no profile row is a normal state, not an error', () => {
  const loadProfile = js.slice(js.indexOf('async function loadProfile'), js.indexOf('function updateAvatarDisplay'));
  assert.match(loadProfile, /\.from\("profiles"\)[\s\S]*?\.maybeSingle\(\)/,
    'the profile read must use maybeSingle()');
  assert.match(loadProfile, /const profile = data \|\| \{/,
    'and must still fall back to defaults when there is no row');
});

check('an invalid invite code reports the message instead of a 406', () => {
  // Slice to the next top-level function after joinHousehold. Joining to persistMembershipToBackend
  // looks right but that function is defined *earlier* in the file, so the slice is empty and the
  // assertions below would silently pass or fail for the wrong reason.
  const start = js.indexOf('async function joinHousehold');
  const end = js.indexOf('\nfunction ', start + 10);
  const raw = js.slice(start, end > start ? end : start + 1200);
  assert.ok(raw.includes('joinHousehold'), 'joinHousehold must exist');
  // Strip comments: a multi-line comment between .eq() and .maybeSingle() is the whole reason this
  // test exists, and matching across raw text would not survive it.
  const join = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(join, /\.eq\("invite_code", code\)[\s\S]*?\.maybeSingle\(\)/,
    'the invite-code lookup must use maybeSingle() so the "Invalid invite code." branch is reachable');
  assert.match(join, /msg\.textContent = "Invalid invite code\.";/,
    'the invalid-code message must still be shown to the user');
  // The branch must actually be reachable, i.e. the null check has to come after the query.
  const queryAt = join.indexOf('.maybeSingle()');
  const checkAt = join.indexOf('if (!house)');
  assert.ok(queryAt > -1 && checkAt > queryAt, 'the !house guard must follow the query to be reachable');
});

check('loadProfile does not re-fetch the user it already has in memory', () => {
  const loadProfile = js.slice(js.indexOf('async function loadProfile'), js.indexOf('function updateAvatarDisplay'));
  assert.doesNotMatch(loadProfile, /sb\.auth\.getUser\(\)/,
    'reading the email back from /auth/v1/user is a redundant round trip — the session has it');
  assert.match(loadProfile, /const email = currentUserEmail \|\| "";/,
    'the email must come from the session already held in memory');
  assert.match(js, /let currentUserEmail = "";/, 'currentUserEmail must be declared');
  assert.match(js, /currentUserEmail = session\.user\.email \|\| "";/,
    'currentUserEmail must be set from the session on sign-in');
  assert.match(js, /currentUserEmail = "";/,
    'and cleared on sign-out so a stale address cannot be shown to the next user');
});

check('applyFormatPrefs is not called twice in a row', () => {
  const loadProfile = js.slice(js.indexOf('async function loadProfile'), js.indexOf('function updateAvatarDisplay'));
  const calls = (loadProfile.match(/applyFormatPrefs\(/g) || []).length;
  assert.equal(calls, 1, `applyFormatPrefs must run once per load, found ${calls}`);
});

check('matches are ranked, not in insertion order', () => {
  assert.deepEqual(titles(searchApi.searchMatches('proposal')), ['Draft Atlas proposal']);
});

check('the AI context leads with the best match', () => {
  const pool = searchApi.askContextPool('atlas');
  assert.ok(pool.length > 0, 'ask context must not be empty for a matching query');
  assert.equal(pool[0].title, 'Draft Atlas proposal', 'the best match must lead the context');
});

check('archived items never enter search or the AI context', () => {
  const ids = [...searchApi.searchMatches('gym'), ...searchApi.askContextPool('gym')].map((i) => i.id);
  assert.ok(!ids.includes('e'), 'an archived item leaked into the results');
});

check('the AI context stays inside the provider token limit', () => {
  const many = { ...stubDeps, state: { items: Array.from({ length: 200 }, (_, n) => ({ id: `x${n}`, kind: 'task', title: `Item ${n}`, created: n })) } };
  const pool = runSearch(many, 'askContextPool("item")');
  assert.ok(pool.length > 0 && pool.length <= 20, `context pool must stay small, got ${pool.length}`);
});

check('natural words map to the values the app stores', () => {
  // "urgent" is typed; priority is stored as "high". Without the alias map this finds nothing.
  assert.ok(titles(searchApi.searchMatches('urgent')).includes('Renew gym membership'),
    '"urgent" must match an item whose priority is stored as high');
  // "blocked" is typed; the status is stored as "waiting".
  assert.ok(titles(searchApi.searchMatches('blocked')).includes('Water plants'),
    '"blocked" must match an item whose status is stored as waiting');
});

check('a broad question still gets enough context to answer', () => {
  // One keyword match must not leave the model with a single item to reason about.
  const pool = searchApi.askContextPool('what i do now');
  assert.ok(pool.length >= 4, `broad questions need real context, got ${pool.length}`);
  assert.ok(!pool.some((i) => i.id === 'e'), 'archived filler leaked into the context');
  assert.equal(new Set(pool.map((i) => i.id)).size, pool.length, 'the context must not repeat an item');
});

check('the checklist is searchable and reaches the model', () => {
  // "repot" only exists inside a checklist step, so it is invisible without that field.
  assert.ok(titles(searchApi.searchMatches('repot')).includes('Water plants'),
    'checklist steps must be searchable');
});

check('the AI prompt carries the date and the workflow state', () => {
  // Without the date "what is due today" is unanswerable; without status/project the model
  // cannot reason about workflow state at all, because those fields never reached it.
  const askSource = js.slice(js.indexOf('function buildAskPrompt'));
  assert.match(askSource, /function buildAskPrompt\(q, items, today\)/, 'buildAskPrompt must take the date');
  assert.match(askSource, /Today is \$\{today\}/, 'the prompt must state the current date');
  assert.match(askSource, /item\.status/, 'the prompt must carry the item status');
  assert.match(askSource, /item\.project/, 'the prompt must carry the project');
  const server = fs.readFileSync(path.join(root, 'api/ask.js'), 'utf8');
  assert.match(server, /const currentDate = String\(today/, 'the API must prefer the client date');
  assert.match(server, /item\.status/, 'buildContextLine must render the status');
  assert.match(server, /item\.project/, 'buildContextLine must render the project');
});

check('a slow answer cannot overwrite a newer one', () => {
  assert.match(js, /let askRequestSeq = 0;/, 'askRequestSeq missing');
  assert.match(js, /const isSuperseded = \(\) =>/, 'the superseded-response guard is missing');
  const ask = js.slice(js.indexOf('async function askAI'));
  const writes = (ask.match(/\bshow\(`/g) || []).length;
  assert.ok(writes >= 4, `every answer write must go through show(), found ${writes}`);
});

check('a re-rendered dropdown cannot discard the answer already on screen', () => {
  // Regression: runSearch() rebuilds the dropdown markup on every keystroke, which detaches the
  // #searchAskSlot node askAI had captured. The old guard tested `slot.isConnected` and threw the
  // answer away, so the dropdown sat on "Thinking…" forever — the real cause of a search that
  // "does not work". The slot must now be re-resolved by id, and only a *newer* call may discard.
  const ask = js.slice(js.indexOf('async function askAI'), js.indexOf('function readAskError'));
  assert.doesNotMatch(ask, /isConnected/, 'a detached node must not be treated as a stale answer');
  assert.doesNotMatch(ask, /isStale/, 'the old disconnect-based guard must be gone');
  assert.match(ask, /const mountId = opts\.mount \? opts\.mount\.id : "aiAnswerSlot"/,
    'the mount must be identified so it can be re-resolved');
  assert.match(ask, /const slot = \(\) => \(mountId \? document\.getElementById\(mountId\) : null\)/,
    'the slot must be looked up live rather than captured once');
  assert.match(ask, /const isSuperseded = \(\) => ticket !== askRequestSeq;/,
    'only a newer call may discard an answer, not a re-render');
  // The dropdown must also carry a finished answer across a re-render.
  assert.match(js, /const previousAnswer = document\.getElementById\("searchAskSlot"\)\?\.innerHTML/,
    'a finished answer must survive the hit list being re-rendered');
});

check('multi-line AI answers keep their line breaks', () => {
  const style = css.match(/\.ask-answer\s*\{[^}]*\}/);
  assert.ok(style, '.ask-answer block missing');
  assert.match(style[0], /white-space:\s*pre-wrap/, 'answers collapse into one run-on line without pre-wrap');
});

check('dictation language is chosen, not inherited from the browser', () => {
  // navigator.language meant a Tamil or Hindi speaker got English transcription.
  assert.match(html, /id="voiceLangRow"/, 'the language picker is missing from the capture sheet');
  assert.match(js, /const VOICE_LANGUAGES = \[/, 'VOICE_LANGUAGES is missing');
  for (const tag of ['ta-IN', 'hi-IN', 'te-IN', 'kn-IN', 'ml-IN', 'en-IN']) {
    assert.match(js, new RegExp(tag), `${tag} is not offered`);
  }
  // The recogniser must be told which language to use.
  assert.match(js, /recognition\.lang = captureVoiceLang;/, 'the recogniser ignores the chosen language');
  assert.doesNotMatch(js, /recognition\.lang = navigator\.language/, 'dictation still falls back to navigator.language');
  // Rendering the picker on open is what makes it usable.
  assert.match(js, /function renderVoiceLanguages\(\)/, 'renderVoiceLanguages is missing');
  assert.match(js, /renderVoiceLanguages\(\);/, 'the language picker is never rendered');
  // The language is stored with the capture so a transcript can be read back later.
  assert.match(js, /language: kind === "voice" && captureVoiceLanguage/, 'the dictated language is not saved');
});

check('the language picker is styled on desktop, not only on phones', () => {
  // Styles added inside the 900px block would leave the desktop capture sheet unstyled.
  const base = css.slice(0, css.indexOf('@media (max-width'));
  assert.match(base, /\.voice-lang-block\s*\{/, '.voice-lang-block must have a base rule');
  assert.match(base, /#voiceLangRow\s*\{/, '#voiceLangRow must have a base rule');
});

check('image text reading is local, opt-in and cannot break capture', () => {
  assert.match(html, /id="imageOcrBtn"/, 'the read-text button is missing');
  assert.match(html, /id="imageOcrLangRow"/, 'the OCR language picker is missing');
  assert.match(js, /async function runImageOcr\(\)/, 'runImageOcr is missing');
  // It must be free and private: the engine comes from a CDN, not from an AI provider key.
  assert.match(js, /tesseract\.js@5/, 'the OCR engine is not the local Tesseract build');
  assert.doesNotMatch(js, /runImageOcr[\s\S]{0,400}GROQ_API_KEY/, 'OCR must not call a paid provider');
  // Opt-in: the library is only fetched when the button is pressed, never on page load.
  assert.match(js, /function loadOcrEngine\(\)/, 'the lazy loader is missing');
  assert.match(js, /document\.createElement\("script"\)/, 'the engine must be injected on demand');
  assert.doesNotMatch(html, /tesseract/i, 'OCR must not load on every page view');
  // Failure must be survivable, so a blocked CDN cannot break the capture sheet.
  assert.match(js, /catch \(error\)[\s\S]{0,400}?You can still type the note yourself\./, 'a failed read must still leave capture usable');
  // The recognised text must re-enter the existing smart-capture pipeline, not a new path.
  assert.match(js, /onCaptureInput\(\);[\s\S]{0,80}\} catch \(error\)/, 'OCR text must go through onCaptureInput');
  assert.match(js, /ocrText: kind === "image"/, 'the recognised text must be saved with the capture');
});

check('the OCR language picker is styled and reset with the capture sheet', () => {
  const base = css.slice(0, css.indexOf('@media (max-width'));
  assert.match(base, /#voiceLangRow\s*\{/, 'language chip styles are missing');
  assert.match(js, /renderOcrLanguages\(\);/, 'the OCR language picker is never rendered on open');
  assert.match(js, /imageOcrText = "";[\s\S]{0,200}?renderOcrLanguages\(\);/, 'OCR state must reset when the sheet opens');
});

check('smart capture is no longer regex-only, and the local rules still run first', () => {
  // The old path only tried window.claude (which never exists on Vercel) and then fell back to
  // regex, so capture never actually used the model even though /api/ask worked.
  assert.match(js, /async function requestModelExtraction\(text\)/, 'the model extraction call is missing');
  assert.match(js, /action: "extract"/, 'the extract action is never sent');
  assert.doesNotMatch(js, /window\.claude\?\.use\("sample"\)/, 'the dead artifact path is still the AI path');
  // Local first, so a plain capture stays instant and free.
  const fn = js.slice(js.indexOf('async function extractWithAI'));
  const localAt = fn.indexOf('extractLocally(text)');
  const modelAt = fn.indexOf('requestModelExtraction(text)');
  assert.ok(localAt > -1, 'the local rules must still run');
  assert.ok(modelAt > localAt, 'the local result must be applied before the model is asked');
  assert.match(fn, /if \(ai\) applyExtraction/, 'a model failure must leave the local result standing');
  assert.match(js, /if \(document\.getElementById\("captureText"\)\.value !== text\) return;/,
    'a stale model reply must be discarded');
  // The model must not be called for a capture the rules already read confidently.
  assert.match(js, /function captureNeedsModelHelp\(text, local\)/, 'the help gate is missing');
  assert.match(js, /local\?\.confidence !== "high"/, 'a confident local read must not call the model');
  assert.match(js, /splitCaptureClauses\(text\)\.length > 1/, 'a multi-clause sentence must reach the model');
});

check('the local rules report how confident they are', () => {
  assert.match(js, /const VAGUE_TIME_RE =/, 'the vague-time pattern is missing');
  assert.match(js, /const COMMITMENT_RE =/, 'the commitment pattern is missing');
  assert.match(js, /result\.confidence = "low";/, 'a vague time must lower confidence');
  assert.match(js, /result\.confidence = "high";/, 'a date plus a kind must be high confidence');
  assert.match(js, /function mergeExtractions\(local, ai\)/, 'the merge helper is missing');
  // A confident local read must never be overwritten by the model.
  assert.match(js, /const preferModel = local\.confidence !== "high";/, 'the model must not win on a confident read');
});

check('a stated fact about someone is a memory, not a task', () => {
  // "email"/"call" are task verbs, so "Ravi prefers WhatsApp instead of email" used to be read
  // as work. Misfiling knowledge as a task is the one kind error a memory engine must not make.
  const kind = js.slice(js.indexOf('function extractLocally'), js.indexOf('function captureNeedsModelHelp'));
  assert.match(kind, /prefers\?\|likes\?/,
    'a stated preference or fact must win over the task verbs');
  assert.match(kind, /result\.kind = "memory"/,
    'a preference must be classified as a memory');
  // It must be checked after waiting/openloop so those stronger signals are not displaced.
  const waiting = kind.indexOf('result.kind = "waiting"');
  const openloop = kind.indexOf('result.kind = "openloop"');
  const memory = kind.indexOf('result.kind = "memory"');
  assert.ok(waiting > -1 && openloop > -1 && memory > -1, 'all three rules must exist');
  assert.ok(memory > openloop && openloop > waiting, 'waiting and open loop must take precedence over memory');
});

check('an uncertain value is asked about, never invented', () => {
  assert.match(html, /id="captureQuestion"/, 'the question card is missing from the capture sheet');
  assert.match(js, /function buildCaptureQuestions\(text, data\)/, 'the question builder is missing');
  assert.match(js, /id: "vague-date"/, 'a vague date must raise a question');
  assert.match(js, /id: "commitment"/, 'a promise must raise a question');
  // One at a time, and never blocking: both are core product promises.
  assert.match(js, /const question = captureQuestions\[0\];/, 'questions must be shown one at a time');
  // The card is built in script.js, so the dismiss control is asserted there rather than in the
  // markup, which only holds the empty container.
  assert.match(js, /onclick="dismissCaptureQuestion\(\)"/, 'a question must be dismissible');
  assert.match(js, /function dismissCaptureQuestion\(\)/, 'dismissCaptureQuestion is missing');
  assert.match(js, /dismissCaptureQuestion\(\);[\s\S]{0,80}Suggestions cleared/, 'clearing suggestions must also drop the question');
  // A decision the person made must survive "Clear suggestions".
  assert.match(js, /captureSuggestionFields\.captureDueDate = null;/, 'an answered date must not be cleared');
  // The card must be hidden by default so it never appears as an empty box.
  assert.match(html, /id="captureQuestion"[^>]*hidden/, 'the question card must start hidden');
  assert.match(css, /\.capture-question\[hidden\]\s*\{[\s\S]*?display:\s*none/, 'a hidden question card must not take up space');
});

check('capture is never blocked by the AI being unavailable', () => {
  // A failed model call must resolve to null rather than rejecting into the capture flow.
  const fn = js.slice(js.indexOf('async function requestModelExtraction'));
  assert.match(fn, /if \(!res\.ok\) return null;/, 'a non-OK response must not throw');
  assert.match(fn, /catch \(error\) \{\s*return null;/, 'a network failure must not throw');
  assert.match(js, /if \(isFileProtocol\(\)\) return null;/, 'a file:// page must not attempt the call');
});

check('the Ask overlay still has an entry point for keyboard users', () => {
  assert.match(js, /openAsk\(\);\s*\n\s*return;/, 'Ctrl+K no longer opens the overlay');
  assert.match(html, /id="askInput"/, 'the overlay input was removed');
  assert.match(js, /function openAsk\(prefill = ""\)/, 'openAsk should accept a prefill');
});

check('the shell never serves a mixed build', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  // Shell files must be network-first: stale CSS/JS beside fresh HTML is what broke the UI.
  assert.match(sw, /function isShellRequest\(/, 'isShellRequest missing');
  assert.match(
    sw,
    /isNavigationRequest\(request\) \|\| isShellRequest\(request\)[\s\S]{0,120}networkFirst/,
    'shell requests must go through networkFirst',
  );
  assert.match(sw, /type === 'SKIP_WAITING'/, 'the worker must accept a SKIP_WAITING message');
});

check('a version mismatch repairs itself instead of staying broken', () => {
  const jsBuild = js.match(/const APP_BUILD = "([^"]+)"/);
  const htmlBuild = html.match(/<meta name="everything-build" content="([^"]+)"/);
  assert.ok(jsBuild, 'APP_BUILD missing from script.js');
  assert.ok(htmlBuild, 'the everything-build meta tag is missing from index.html');
  assert.equal(
    htmlBuild[1],
    jsBuild[1],
    'index.html and script.js disagree on the build, so every load would self-reload',
  );
  assert.match(js, /function repairVersionMismatch\(\)/, 'repairVersionMismatch missing');
  assert.match(js, /repairVersionMismatch\(\);/, 'the repair is never run at startup');
  // The reload must be guarded, or a broken deploy would loop forever.
  assert.match(js, /sessionStorage\.getItem\("everythingBuildRepair"\)/, 'the reload must be guarded by a session flag');
});

check('the service worker cache is versioned and current', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const version = sw.match(/CACHE_NAME = 'everything-shell-v(\d+)'/);
  assert.ok(version, 'the shell cache is not versioned');
  assert.ok(Number(version[1]) >= 13, `shell cache is v${version[1]}, expected at least v13`);
});

check('CSS braces are balanced', () => {
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  assert.equal(open, close, `unbalanced braces: ${open} open vs ${close} close`);
});

await Promise.all(inflight);
console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nALL ${results.length} TESTS PASSED`);
