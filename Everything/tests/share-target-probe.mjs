// Proves the share target end to end, by POSTing a real share the way Android's share sheet does.
//
//   node Everything/tests/share-target-probe.mjs
//
// A share target receives a POST, which is a navigation a page cannot render. So the interesting
// failures here are silent ones: the app opens and the shared words are simply gone. These checks
// drive the real service worker with a real multipart body and read what the page actually collects.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4416;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // Real writes are stubbed out so nothing reaches an account — but the share POST below must
  // genuinely reach the service worker, so the real fetch is kept under a separate name.
  await page.evaluate(() => {
    window.__realFetch = window.fetch.bind(window);
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
  });
  // The worker must be controlling the page before a share can reach it.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });

  // A real share is a TOP-LEVEL NAVIGATION, not a fetch: the OS opens the app at the share target.
  // Submitting an actual form is the only faithful reproduction, and it is what the worker's 303
  // redirect is written for. Using fetch() here would follow the redirect silently, leave the page
  // on its old URL, and never run the collection code — a green test for a broken feature.
  const share = async (fields) => {
    await page.evaluate((fields) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = './?share=1';
      form.enctype = 'multipart/form-data';
      for (const [key, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }, fields);
    await page.waitForLoadState('commit');
  };

  await check('the manifest actually declares a share target', async () => {
    // Fetched through Playwright rather than page.evaluate: the setup above stubs window.fetch to
    // stop real writes reaching an account, and that stub would hand back an empty object here.
    const response = await page.request.get(testUrl(PORT, 'manifest.json'));
    const manifest = await response.json();
    assert.ok(manifest.share_target, 'no share_target in the manifest — the OS will never offer it');
    assert.equal(manifest.share_target.method, 'POST', 'a GET share target would drop the shared text');
    assert.ok(manifest.share_target.params.text, 'shared text is not requested');
    assert.ok(manifest.share_target.params.url, 'a shared link is not requested');
  });

  await check('the shell cache is versioned, so a new manifest reaches the phone', async () => {
    // A share target added without a cache bump is invisible to anyone who already installed the
    // app: the worker keeps serving the old manifest and the OS never offers to share.
    const names = await page.evaluate(() => caches.keys());
    const shell = names.find((n) => n.startsWith('everything-shell-v'));
    assert.ok(shell, `no shell cache found (saw ${JSON.stringify(names)})`);
    const served = await page.evaluate(async () => {
      const cache = await caches.open((await caches.keys()).find((n) => n.startsWith('everything-shell-v')));
      const hit = await cache.match('./manifest.json');
      if (!hit) return 'not cached';
      const text = await hit.text();
      return text.includes('share_target') ? 'current' : 'STALE';
    });
    assert.equal(served, 'current', 'the worker is serving a pre-share-target manifest from cache');
  });

  await check('a shared sentence is captured and READ, not just filed', async () => {
    // The whole point: sharing must be a first-class way to capture, so the sentence goes through
    // the same reader as typing and dictation.
    await share({ text: 'call Ravi tomorrow' });
    await page.waitForFunction(() => document.getElementById('captureText').value.length > 0, null, { timeout: 15000 });
    const r = await page.evaluate(() => {
      const input = document.getElementById('captureText');
      return {
        value: input.value,
        open: document.getElementById('captureModal').classList.contains('open'),
        url: location.search,
      };
    });
    assert.match(r.url, /share=1/, `the page never landed on the share url: "${r.url}"`);
    assert.equal(r.open, true, 'the capture sheet did not open for a share');
    assert.match(r.value, /call Ravi tomorrow/i, `the shared text was dropped: "${r.value}"`);
  });

  await check('a shared link keeps its URL', async () => {
    await share({ title: 'Atlas proposal', url: 'https://example.com/atlas' });
    await page.waitForFunction(
      () => document.getElementById('linkUrlInput').value.includes('example.com'),
      null,
      { timeout: 15000 },
    );
    const r = await page.evaluate(() => ({
      link: document.getElementById('linkUrlInput').value,
      text: document.getElementById('captureText').value,
    }));
    assert.match(r.link, /https:\/\/example\.com\/atlas/, `the link was lost: "${r.link}"`);
    // Title and URL are joined, because reading only the title would throw the link away.
    assert.match(r.text, /Atlas proposal/, `the shared title was lost: "${r.text}"`);
  });

  await check('a share is collected once, and a reload does not repeat it', async () => {
    // Without consuming it, every reload would reopen the sheet with the same words.
    await share({ text: 'renew the passport' });
    await page.waitForFunction(() => document.getElementById('captureText').value.includes('passport'), null, { timeout: 15000 });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({
      value: document.getElementById('captureText').value,
      open: document.getElementById('captureModal').classList.contains('open'),
    }));
    assert.equal(after.open, false, 'a reload reopened the capture sheet with the old share');
    assert.equal(after.value, '', `the share came back on reload: "${after.value}"`);
  });

  await check('an empty share does not open an empty sheet', async () => {
    await share({ text: '' });
    await page.waitForTimeout(1800);
    const r = await page.evaluate(() => document.getElementById('captureModal').classList.contains('open'));
    assert.equal(r, false, 'sharing nothing opened a blank capture sheet');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nSHARE TARGET CHECKS FAILED' : `\nALL ${results.length} SHARE TARGET CHECKS PASSED`);
