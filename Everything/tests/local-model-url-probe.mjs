// Proves the Ollama address handling, which is what makes a free tunnel usable from a phone.
//
//   node Everything/tests/local-model-url-probe.mjs
//
// A Cloudflare quick tunnel prints its address inside a banner, and hands out a NEW address every
// time cloudflared restarts. Both are guaranteed to happen, and both used to produce a baffling
// "not reachable" with no indication of what had actually gone wrong.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4418;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // Nothing here may reach a real model, so every fetch to the address fails closed.
  await page.evaluate(() => { window.fetch = () => Promise.reject(new TypeError('Failed to fetch')); });

  const clean = (value) => page.evaluate((value) => normaliseLocalModelUrl(value), value);

  await check('a bare address is accepted and trimmed', async () => {
    assert.equal(await clean('https://abc-def.trycloudflare.com'), 'https://abc-def.trycloudflare.com');
    assert.equal(await clean('http://localhost:11434/'), 'http://localhost:11434');
  });

  await check('the whole cloudflared banner can be pasted', async () => {
    // What actually happens: people select the line cloudflared printed, banner and all.
    const banner = await clean(
      '2026-09-28 09:14:22Z INF +----------------------------------------------------------------+\n' +
      '2026-09-28 09:14:22Z INF |  https://odd-words-here.trycloudflare.com                      |\n' +
      '2026-09-28 09:14:22Z INF +----------------------------------------------------------------+\n',
    );
    assert.equal(banner, 'https://odd-words-here.trycloudflare.com',
      `the banner was not unwrapped: "${banner}"`);
  });

  await check('nonsense is rejected rather than saved', async () => {
    // A bad value must fall back to the working default, not be stored and silently fail forever.
    assert.equal(await clean('not a url at all'), '');
    assert.equal(await clean(''), '');
  });

  await check('a stale quick-tunnel address says exactly what to do', async () => {
    const reason = await page.evaluate(() =>
      localModelFailureReason('https://old-name.trycloudflare.com'));
    assert.match(reason, /new one every time/i,
      `a stale tunnel must be named as the cause, got: "${reason}"`);
    assert.match(reason, /paste/i, 'the reason must tell you what to do about it');
  });

  await check('a localhost failure points at Ollama and OLLAMA_ORIGINS', async () => {
    const reason = await page.evaluate(() => localModelFailureReason('http://localhost:11434'));
    assert.match(reason, /Ollama/, `got: "${reason}"`);
    assert.match(reason, /OLLAMA_ORIGINS/, `the CORS cause is the common one and must be named: "${reason}"`);
  });

  await check('a dead address is not blamed on the tunnel', async () => {
    // Misdiagnosing a genuine outage as a stale tunnel would send people chasing the wrong thing.
    const reason = await page.evaluate(() => localModelFailureReason('https://ollama.example.com'));
    assert.doesNotMatch(reason, /every time/i, 'an unrelated address was blamed on the tunnel');
  });

  await check('the settings card offers the tunnel instructions', async () => {
    const r = await page.evaluate(() => ({
      hasField: !!document.getElementById('localModelUrl'),
      hasHelp: document.querySelector('details summary')?.textContent.trim() || '',
      // textContent, not innerText: the instructions sit inside a collapsed <details>, and
      // innerText deliberately omits anything not currently rendered.
      hasCommand: (document.body.textContent || '').includes('cloudflared tunnel --url'),
    }));
    assert.equal(r.hasField, true, 'the Ollama address field is missing');
    assert.match(r.hasHelp, /phone/i, 'nothing in the card mentions using it from a phone');
    assert.equal(r.hasCommand, true, 'the card does not give the tunnel command');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nLOCAL MODEL CHECKS FAILED' : `\nALL ${results.length} LOCAL MODEL CHECKS PASSED`);
