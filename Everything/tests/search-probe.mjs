// Real-browser check for search. The matcher runs in the page, so the honest way to test it is
// to seed real items and ask real queries rather than to re-implement the rules here.
//   node Everything/tests/search-probe.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4406;

const server = await startTestServer(PORT);

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
};

const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

/* Titles are chosen so each query has exactly one plausible answer. A check that passes because
   something unrelated also matched is worse than no check, so every assertion names the item. */
const titles = (q) => page.evaluate((query) => searchMatches(query).map((item) => item.title), q);
const seed = (rows) => page.evaluate((items) => {
  state.items = items.map((row, i) => ({
    id: `s${i}`, kind: 'task', title: row, sub: '', person: '', project: '',
    priority: 'normal', done: false, created: 1000 + i,
  }));
}, rows);

try {
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.searchMatches === 'function');

  await check('an exact match still works and still comes first', async () => {
    await seed(['Buy groceries', 'Renew passport']);
    assert.deepEqual(await titles('groceries'), ['Buy groceries']);
    assert.deepEqual(await titles('passport'), ['Renew passport']);
  });

  await check('a plural finds the singular it was typed against', async () => {
    await seed(['Grocery run', 'Renew passport']);
    // "groceries" is the plural and the capture is singular. Substring matching cannot do this.
    assert.deepEqual(await titles('groceries'), ['Grocery run']);
  });

  await check('a singular finds the plural', async () => {
    await seed(['Buy groceries', 'Renew passport']);
    assert.deepEqual(await titles('grocery'), ['Buy groceries']);
  });

  await check('a single typo still finds the item', async () => {
    await seed(['Renew passport', 'Fix the plumbing']);
    assert.deepEqual(await titles('passprt'), ['Renew passport'], 'a dropped letter');
    assert.deepEqual(await titles('passpot'), ['Renew passport'], 'a transposed pair');
    assert.deepEqual(await titles('plumibng'), ['Fix the plumbing'], 'a typo plus a dropped letter');
  });

  await check('an unrelated word still finds nothing', async () => {
    await seed(['Renew passport', 'Fix the plumbing']);
    // The failure mode of typo tolerance is inventing matches. Neither of these is near "zebra".
    assert.deepEqual(await titles('zebra'), []);
    assert.deepEqual(await titles('helicopter'), []);
  });

  await check('short words are never fuzzy matched', async () => {
    await seed(['Book the car', 'Book the cat', 'Book the can']);
    // "car" is one edit from both "cat" and "can". Below the length guard a typo must find
    // nothing, rather than returning the wrong two of the three.
    assert.deepEqual(await titles('car'), ['Book the car'], 'exact is still fine');
    assert.deepEqual(await titles('ctr'), [], 'a 3-letter query must not fuzzy match anything');
  });

  await check('an exact hit is never pushed down by a fuzzy one', async () => {
    // "Pasport" is one dropped letter from "passport" and does not contain it, so only the first
    // title is an exact match. The fuzzy pass would happily return the second, and must not run.
    await seed(['Renew passport', 'Pasport photocopied at the arcade']);
    assert.deepEqual(await titles('passport'), ['Renew passport']);
  });

  await check('more query words still narrow the result', async () => {
    await seed(['Grocery run', 'Grocery list', 'Passport renewal']);
    // AND, not OR: adding a word must shrink the set, or fuzzy would widen every search.
    const both = await titles('grocery list');
    assert.deepEqual(both, ['Grocery list']);
    assert.ok((await titles('grocery')).length > both.length, 'the shorter query must be broader');
  });

  await check('aliases still reach a priority task, so that search is unchanged', async () => {
    // Priority has to be genuinely high here: the alias table maps the word "urgent" onto the
    // stored value "high", and the haystack is what carries the priority.
    await page.evaluate(() => {
      state.items = [
        { id: 'p', kind: 'task', title: 'Ship the invoice', priority: 'high', created: 1 },
        { id: 'q', kind: 'task', title: 'Renew passport', priority: 'normal', created: 2 },
      ];
    });
    // "urgent" appears in no title; it reaches the high-priority task through the alias table.
    assert.deepEqual(await titles('urgent'), ['Ship the invoice']);
  });

  await check('a stop-word-only query still resolves to real terms', async () => {
    await seed(['Grocery run', 'Passport renewal']);
    // searchTerms falls back to the whole string here, so "the" stays a live term and must
    // simply find nothing.
    assert.deepEqual(await titles('the'), []);
  });

  await check('a long sentence is refused rather than guessed at', async () => {
    await seed(['Grocery run', 'Passport renewal']);
    const many = await titles('one two three four five six seven eight nine');
    assert.deepEqual(many, [], 'past the term cap a fuzzy match is coincidence, not correction');
  });

  await check('archived items stay out of fuzzy results too', async () => {
    await page.evaluate(() => {
      state.items = [
        { id: 'a', kind: 'task', title: 'Grocery run', created: 1, archivedAt: Date.now() },
        { id: 'b', kind: 'task', title: 'Renew passport', created: 2 },
      ];
    });
    assert.deepEqual(await titles('grocery'), [], 'an archived item must not reappear');
  });

  await check('search stays fast on a large archive', async () => {
    // Typing runs this on every keystroke, so a slow fuzzy pass would be felt immediately.
    await page.evaluate(() => {
      const filler = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
      state.items = Array.from({ length: 2000 }, (_, i) => ({
        id: `perf${i}`, kind: 'task', title: `Item ${i} ${filler}`,
        sub: `notes about quarterly reporting and budget ${i}`, created: i,
      }));
    });
    const worst = await page.evaluate(() => {
      // A typo, so the exact pass finds nothing and the whole fuzzy path is exercised.
      const t0 = performance.now();
      searchMatches('quatrly');
      return performance.now() - t0;
    });
    assert.ok(worst < 1500, `fuzzy search over 2000 items took ${worst.toFixed(0)}ms`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSEARCH CHECKS FAILED' : `\nALL ${results.length} SEARCH CHECKS PASSED`);
