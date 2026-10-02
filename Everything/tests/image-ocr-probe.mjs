// Proves that reading text from an attached image actually works, in every language the app offers.
//
//   node Everything/tests/image-ocr-probe.mjs
//
// This exists because the feature looked finished and had never once succeeded. Reading an image is
// opt-in and failure-tolerant by design: when the language pack cannot be fetched the app degrades to
// "type the note yourself", so a total failure looks identical to a working feature nobody used.
// Nothing errored, nothing was logged, and the suite stayed green.
//
// The cause was a name, not a network. The app stored two-letter tags (`en`, `ta`, `ml`) while
// tesseract's packs are published under three-letter ISO 639-2 codes (`eng`, `tam`, `mal`). Every
// language was therefore asked for by a filename that exists nowhere, and the read waited on a
// response that could never arrive:
//
//   @tesseract.js-data/en/4.0.0_best_int/en.traineddata.gz     404
//   @tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz   200, 2,952,873 bytes
//
// So this probe asserts on what comes back rather than on what was requested: real rendered text, in
// each script, read through the real button and landing in the real textarea. A stubbed CDN cannot
// help here, because a stub is equally happy returning bytes for a name that does not exist — the bug
// lived in the URL, not in the response.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, bootApp } from './test-server.mjs';

let PORT = 4440;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

/* The languages the app offers, each with the pack name it is actually published under. Keeping both
   spellings here is the point: the failure this guards against is the two being confused. */
const LANGUAGES = [
  { tag: 'en', code: 'eng', phrase: 'WARRANTY' },
  { tag: 'ta', code: 'tam', phrase: 'நம்பிக்கை' },
  { tag: 'hi', code: 'hin', phrase: 'वारंटी' },
  { tag: 'te', code: 'tel', phrase: 'వారంటీ' },
  { tag: 'kn', code: 'kan', phrase: 'ವಾರಂಟಿ' },
  { tag: 'ml', code: 'mal', phrase: 'വാരന്റി' },
];
const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(120000);

  // Every language pack requested during the run, so a check can name the URL that was actually used.
  const packs = [];
  page.on('response', (r) => {
    if (/\/ocr-lang\//.test(r.url())) packs.push({ name: r.url().split('/').pop(), status: r.status() });
  });

  await bootApp(page, PORT);
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // The worker must control the page before a pack is asked for: a fetch only reaches it once it
  // does, and a first-ever load is not yet in that state. A person attaching a photo always is.
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 })
    .catch(() => {});
  await page.evaluate(() => { window.openCapture(); window.pickType('image', true); });
  await page.waitForTimeout(500);

  /* Renders `phrase` to a canvas, hands it to the real file input, presses the real button and waits
     for the read to settle. Returns whatever landed in the capture textarea.

     `window.fetch` is deliberately left alone. Earlier attempts stubbed it to keep Supabase quiet, and
     that quietly broke the very fetches being measured — producing convincing nonsense and sending
     the diagnosis down two wrong roads before the URL itself was read properly. */
  const readText = (lang) => page.evaluate(async ({ tag, phrase }) => {
    document.getElementById('captureText').value = '';
    window.pickOcrLang(tag);

    const canvas = document.createElement('canvas');
    canvas.width = 780; canvas.height = 210;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 780, 210);
    g.fillStyle = '#000000';
    g.font = 'bold 56px sans-serif';
    g.fillText(phrase, 30, 115);
    const binary = atob(canvas.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    const input = document.getElementById('imageGalleryInput');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Blob([bytes], { type: 'image/png' })], 'photo.png', { type: 'image/png' }));
    input.files = transfer.files;
    window.previewImageFile(input);
    await new Promise((resolve) => setTimeout(resolve, 300));

    document.getElementById('imageOcrBtn').click();
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = document.getElementById('imageOcrStatus')?.textContent || '';
      if (/characters|No text|timed out|failed|not supported/i.test(status)) break;
    }
    return {
      status: (document.getElementById('imageOcrStatus')?.textContent || '').replace(/\s+/g, ' ').trim(),
      text: document.getElementById('captureText')?.value || '',
    };
  }, lang);

  const outcomes = new Map();
  for (const lang of LANGUAGES) {
    const before = packs.length;
    outcomes.set(lang.tag, { ...(await readText(lang)), packs: packs.slice(before) });
  }
for (const lang of LANGUAGES) {
    const got = outcomes.get(lang.tag);
    await check(`${lang.tag} reads text from an image and fills the capture field`, () => {
      // The status is the first thing to look at: a timeout or an empty result is the failure this
      // probe was written for, and it reads differently from a wrong-but-plausible transcript.
      assert.doesNotMatch(
        got.status,
        /timed out|failed|not supported|No text/i,
        `${lang.tag} reported "${got.status}"`,
      );
      assert.ok(
        got.text.trim().length > 0,
        `${lang.tag} produced no text (status: "${got.status}") — the pack is probably requested by the wrong name`,
      );
    });
  }

  await check('every language is fetched under its three-letter pack name', () => {
    // The regression itself. All six were previously requested as en/ta/hi/te/kn/ml, and every one of
    // those URLs 404s, so the read could not complete in any language at all.
    for (const lang of LANGUAGES) {
      const requested = outcomes.get(lang.tag).packs.map((p) => p.name);
      assert.ok(
        requested.includes(`${lang.code}.traineddata.gz`),
        `${lang.tag} requested ${JSON.stringify(requested)}, expected ${lang.code}.traineddata.gz`,
      );
      assert.ok(
        !requested.includes(`${lang.tag}.traineddata.gz`),
        `${lang.tag} asked for the two-letter name, which no host publishes`,
      );
    }
  });

  await check('no language pack is ever answered with an error', () => {
    const bad = packs.filter((p) => p.status !== 200);
    assert.deepEqual(bad, [], `these packs did not load: ${JSON.stringify(bad)}`);
  });

  await check('the recognised text is the text that was in the image', () => {
    // English is checked exactly, because it is the one language whose output can be compared with a
    // known string without a script-handling table. For the others, non-empty output plus the right
    // pack is the achievable assertion: OCR accuracy on rendered Indic script is not this test's job,
    // and a threshold here would be a number someone would tune until it went green.
    const english = outcomes.get('en').text;
    assert.match(english, /WARRANTY/i, `English read as ${JSON.stringify(english)}`);
  });

  await check('a language with no pack is refused rather than read as English', () => {
    // Substituting a default here would read the wrong script and report success, which is worse than
    // failing: the person would file a note in the wrong language believing it was right.
    const resolved = page.evaluate(() => (typeof ocrLangCode === 'function' ? ocrLangCode('zz') : 'missing'));
    return resolved.then((out) => {
      assert.equal(out, null, `an unknown tag resolved to ${JSON.stringify(out)}`);
    });
  });

  console.log('\nWhat each language read:');
  for (const lang of LANGUAGES) {
    const got = outcomes.get(lang.tag);
    const shown = got.text.replace(/\n/g, ' ').slice(0, 40);
    console.log(`  ${lang.tag} -> ${lang.code}.traineddata.gz  ${JSON.stringify(shown)}`);
  }
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => r.startsWith('FAIL')).length;
if (!failed) console.log(`\nALL ${results.length} IMAGE TEXT CHECKS PASSED`);
else console.log(`\n${failed} of ${results.length} image text checks FAILED`);