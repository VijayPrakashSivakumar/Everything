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

/* What the four-line page in the accuracy checks actually says. Held here so the expectation is
   written once and both the shadowed and clean checks are scored against the same string. */
const SHADOW_TRUTH = 'WARRANTY CERTIFICATE Model X200L Serial 88421 Issued on 04 March 2026 Valid till 04 March 2027';

/* Levenshtein similarity, as a fraction. A substring or word-count check would pass on an image that
   returned one correct word out of twenty, which is close enough to the failure this probe exists to
   catch that it would have let the original bug through again. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
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

  /* ------------------------------------------------------------------------------------------
     Accuracy, which is the part that was missing for a long time.

     Everything above checks that text ARRIVES. That is not the same as checking that it is CORRECT,
     and the difference is the whole of this bug: a shadowed photograph lost three lines of four and
     still returned plenty of text, so every "did it work" test above passed happily while the feature
     was unusable. Scoring the words against what is actually on the page is the only check that
     could have caught it.
     ------------------------------------------------------------------------------------------ */

  /* A page of text with a hard shadow across the middle — the condition that used to cost 78.7% of
     the characters. Measured before the fix: 21.3% accurate, three lines of four missing entirely.
     The shadow is optional so the same helper can produce the clean control image. */
  const readShadowed = (lang, withShadow = true) => page.evaluate(async (arg) => {
    const LINES = [
      'WARRANTY CERTIFICATE',
      'Model X200L Serial 88421',
      'Issued on 04 March 2026',
      'Valid till 04 March 2027',
    ];
    const W = 1000; const H = 400;
    const sheet = document.createElement('canvas');
    sheet.width = W; sheet.height = H;
    const s = sheet.getContext('2d');
    s.fillStyle = '#f4f1e8'; s.fillRect(0, 0, W, H);
    s.fillStyle = '#1a1a1a';
    s.font = '500 34px "Segoe UI", Arial, sans-serif';
    LINES.forEach((line, i) => s.fillText(line, 70, 90 + i * 62));

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(sheet, 0, 0);
    if (arg.shadow) {
      // A hand or a window frame across the page.
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.moveTo(0, 150); g.lineTo(W, 90); g.lineTo(W, 300); g.lineTo(0, 340);
      g.closePath(); g.fill();
    }

    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 14;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);

    window.pickOcrLang(arg.tag);
    const input = document.getElementById('imageGalleryInput');
    const binary = atob(c.toDataURL('image/jpeg', 0.75).split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([new Blob([bytes], { type: 'image/jpeg' })], 'photo.jpg', { type: 'image/jpeg' }));
    input.files = dt.files;
    window.previewImageFile(input);
    await new Promise((resolve) => setTimeout(resolve, 300));

    document.getElementById('imageOcrBtn').click();
    for (let i = 0; i < 150; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = document.getElementById('imageOcrStatus')?.textContent || '';
      if (/characters|No text|timed out|failed|not supported/i.test(status)) break;
    }
    return document.getElementById('captureText')?.value || '';
  }, { tag: lang, shadow: withShadow });

  await check('a shadow across the page no longer swallows whole lines', async () => {
    const text = (await readShadowed('en')).replace(/\s+/g, ' ').trim();
    const score = similarity(text.toLowerCase(), SHADOW_TRUTH.toLowerCase());
    // 95% is not an arbitrary bar: before the fix this read 21.3%, and the clean-photo control reads
    // 100%. Anything below 95 means a meaningful part of the page is being dropped again.
    assert.ok(
      score >= 0.95,
      `read ${(score * 100).toFixed(1)}% of a shadowed page, expected 95% or better — got ${JSON.stringify(text)}`,
    );
  });

  await check('a clean photograph still reads perfectly', async () => {
    // The control for the check above: preprocessing that rescues a shadow must not cost accuracy on
    // the easy case, and an earlier candidate (stretch + adaptive + upscale) did exactly that at 97.9%.
    //
    // Scored against the same four-line page as the shadow check rather than the single-word image the
    // language loop uses, so the two numbers are comparable. The six-language loop above has already
    // established that text arrives in every language; this one is about whether it is right.
    const text = (await readShadowed('en', false)).replace(/\s+/g, ' ').trim();
    const score = similarity(text.toLowerCase(), SHADOW_TRUTH.toLowerCase());
    assert.ok(score >= 0.98, `clean page read at ${(score * 100).toFixed(1)}%, expected 98% or better`);
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