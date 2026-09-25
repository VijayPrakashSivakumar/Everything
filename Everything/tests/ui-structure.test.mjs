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
function check(name, fn) {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
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

check('both search entry points share one matcher', () => {
  assert.match(js, /function searchMatches\(q\)/, 'searchMatches helper missing');
  // Exactly one place may build the searchable haystack. searchMatches itself is allowed;
  // any second copy means the two entry points could disagree.
  const defs = js.match(/function searchMatches\(q\)/g) || [];
  assert.equal(defs.length, 1, 'searchMatches must be declared once');
  const body = js.slice(js.indexOf('function searchMatches'));
  const end = body.indexOf('\n}');
  const helper = body.slice(0, end);
  assert.match(helper, /includes\(ql\)/, 'searchMatches must do the matching');
  const outside = js.slice(0, js.indexOf('function searchMatches')) + js.slice(js.indexOf('function searchMatches') + end);
  assert.doesNotMatch(outside, /\.includes\(ql\)/, 'duplicate inline matching logic still exists');
  assert.match(js, /const matches = searchMatches\(q\);/, 'runAsk must reuse searchMatches');
});

check('the AI answer cannot wipe the dropdown hit list', () => {
  assert.match(js, /id="searchAskSlot"/, 'the dropdown needs its own AI slot');
  assert.match(js, /mount:\s*document\.getElementById\("searchAskSlot"\)/, 'askAI must mount into the AI slot');
});

check('the Ask overlay still has an entry point for keyboard users', () => {
  assert.match(js, /openAsk\(\);\s*\n\s*return;/, 'Ctrl+K no longer opens the overlay');
  assert.match(html, /id="askInput"/, 'the overlay input was removed');
  assert.match(js, /function openAsk\(prefill = ""\)/, 'openAsk should accept a prefill');
});

check('CSS braces are balanced', () => {
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  assert.equal(open, close, `unbalanced braces: ${open} open vs ${close} close`);
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nALL ${results.length} TESTS PASSED`);
