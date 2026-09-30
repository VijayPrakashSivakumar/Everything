// Proves a photographed appointment card is *offered* a choice, not filed on a guess.
//
//   node Everything/tests/image-choice-probe.mjs
//
// What this exists for. A picture with a date on it used to be read and then left to the silent
// auto-create, which filed a photographed appointment card as whatever the reading happened to
// call it. A date says when; it does not say whether the thing is an event, a reminder or a record.
// That one decision is offered instead Ã¢â‚¬â€ and until it is answered, nothing is created.
//
// Tesseract is never loaded. The card is built from the text a real read would have left behind, so
// the probe tests the decision, not the OCR.
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
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  /* Exactly what runImageOcr() leaves behind after a real read: the text in the box, the channel
     set to "image", and the recognised text kept for the audit trail. A one-byte PNG stands in for
     the photograph Ã¢â‚¬â€ nothing here decodes it. */
  const shoot = (ocrText) => page.evaluate(async (t) => {
    openCapture();
    await new Promise((r) => setTimeout(r, 120));
    pickType('image', true);
    pendingBlob = new Blob(['x'], { type: 'image/png' });
    imageOcrText = t;
    document.getElementById('captureText').value = t;
    onCaptureInput();
    await new Promise((r) => setTimeout(r, 1100));
    return {
      channel: captureChannel,
      question: (document.querySelector('.capture-question-text') || {}).textContent || '',
      options: [].slice.call(document.querySelectorAll('.capture-question-actions .btn'))
        .map((b) => b.textContent.trim()),
      kind: captureType,
      due: (document.getElementById('captureDueDate') || {}).value || '',
      pending: captureImageChoicePending,
      items: state.items.length,
    };
  }, ocrText);

  const pick = (option) => page.evaluate((label) => {
    const wanted = label.trim().toLowerCase();
    const button = [].slice.call(document.querySelectorAll('.capture-question-actions .btn'))
      .find((b) => b.textContent.trim().toLowerCase() === wanted);
    if (!button) return { missing: true };
    button.click();
    return { kind: captureType, pending: captureImageChoicePending };
  }, option);

  const CARD = 'APOLLO CLINIC\nDr Ramesh\n05 October 2026 4:00 PM\nRoom 12';

  await check('a picture with a date on it is offered a choice', async () => {
    const s = await shoot(CARD);
    assert.equal(s.channel, 'image', 'the capture must still be an image capture');
    assert.match(s.question, /what would you like me to do/i, `expected a choice, got "${s.question}"`);
    assert.deepEqual(s.options, ['Create event', 'Set reminder', 'Save as note'],
      `expected the three options, got ${JSON.stringify(s.options)}`);
    assert.ok(s.due, 'the date on the picture was not read');
    assert.equal(s.pending, true, 'the app must know it is waiting on this answer');
  });

  await check('the choice names the date it actually read', async () => {
    const s = await shoot(CARD);
    assert.match(s.question, /october|oct/i, `the question does not name the month: "${s.question}"`);
  });

  await check('nothing is created until the choice is answered', async () => {
    // The regression this guards: a photographed appointment card silently filed as a task.
    const s = await shoot(CARD);
    assert.equal(s.items, 0, 'a capture that is still being decided must not have created anything');
  });

  await check('"Create event" makes it an event', async () => {
    await shoot(CARD);
    const r = await pick('Create event');
    assert.equal(r.kind, 'event', `expected an event, got ${r.kind}`);
    assert.equal(r.pending, false, 'the wait must end once it is answered');
  });

  await check('"Set reminder" makes it a task that keeps the date', async () => {
    const before = await shoot(CARD);
    const r = await pick('Set reminder');
    assert.equal(r.kind, 'task', `expected a task, got ${r.kind}`);
    assert.ok(before.due, 'there was no date to remind about');
  });

  await check('"Save as note" makes it a memory', async () => {
    await shoot(CARD);
    const r = await pick('Save as note');
    assert.equal(r.kind, 'memory', `expected a memory, got ${r.kind}`);
  });

  await check('a picture with no date and no receipt is never asked anything', async () => {
    // Nothing to offer a choice about, so the card must stay out of the way. A handwritten note has
    // no date, no total and no invoice reference, which is the case this rule exists for.
    const s = await shoot('remember the wifi password is on the router');
    assert.equal(s.pending, false, 'a picture with nothing to decide must not raise a question');
  });

  await check('a receipt with no date is still offered, because its total is enough to decide', async () => {
    // The rule above used to cover this case, and it was wrong for it. A receipt answers its own
    // question Ã¢â‚¬â€ the amount is printed on the paper Ã¢â‚¬â€ so not offering "Record as expense" would mean
    // photographing a receipt got you nothing but a wall of text to read.
    const s = await shoot('receipt\nApollo Pharmacy\nTOTAL 240');
    assert.equal(s.pending, true, 'a readable receipt was not offered the expense option');
    assert.ok(
      s.options.includes('Record as expense'),
      `the expense option is missing from ${JSON.stringify(s.options)}`,
    );
  });

  await check('dismissing the choice never blocks a save', async () => {
    const s = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      pickType('image', true);
      imageOcrText = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      document.getElementById('captureText').value = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      const before = { pending: captureImageChoicePending, items: state.items.length };
      dismissCaptureQuestion();
      return { before, after: { pending: captureImageChoicePending, items: state.items.length } };
    });
    assert.equal(s.before.pending, true, 'the choice should have been raised');
    assert.equal(s.after.items, 0, 'dismissing must not create anything on its own');
  });

  await check('a manually chosen kind is never overridden by the choice', async () => {
    const s = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      pickType('image', true);
      imageOcrText = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      document.getElementById('captureText').value = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      pickType('waiting', true);        // the person decided for themselves
      const button = [].slice.call(document.querySelectorAll('.capture-question-actions .btn'))
        .find((b) => b.textContent.trim() === 'Create event');
      button.click();
      return { kind: captureType, autoDetected: captureAutoDetected };
    });
    assert.equal(s.autoDetected, true, 'a manual choice was forgotten');
    assert.equal(s.kind, 'waiting', 'a manual choice was overridden by the picture card');
  });

  await check('editing the read text drops the choice, because the date is no longer known', async () => {
    const s = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      pickType('image', true);
      imageOcrText = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      document.getElementById('captureText').value = 'APOLLO CLINIC\n05 October 2026 4:00 PM';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      const before = captureImageChoicePending;
      const input = document.getElementById('captureText');
      input.value = 'apologies, wrong photo';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: captureImageChoicePending };
    });
    assert.equal(s.before, true, 'the choice should have been raised');
    assert.equal(s.after, false, 'a stale choice survived an edit that removed the date');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nIMAGE CHOICE CHECKS FAILED' : `\nALL ${results.length} IMAGE CHOICE CHECKS PASSED`);
