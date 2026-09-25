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
const searchSource = [
  between('const SEARCH_STOP_WORDS', ']);'),
  between('const SEARCH_ALIASES', '};'),
  between('function searchAliases', '\n}'),
  between('function searchTerms', '\n}'),
  between('function searchHaystack', '\n}'),
  between('function searchScore', '\n}'),
  between('function searchMatches', '\n}'),
  between('const ASK_CONTEXT_MATCHES', '\n}'),
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
  assert.match(js, /const isStale = \(\) =>/, 'the stale-response guard is missing');
  const ask = js.slice(js.indexOf('async function askAI'));
  const guarded = (ask.match(/if \(isStale\(\)\) return;/g) || []).length;
  assert.ok(guarded >= 3, `every answer write must be guarded, found ${guarded}`);
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
