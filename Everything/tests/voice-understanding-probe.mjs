// Proves a dictated note and a picture of text are *understood*, not just stored.
//
//   node Everything/tests/voice-understanding-probe.mjs
//
// The complaint this exists for: dictation recorded a voice note and stopped there. The transcript
// reached the database, but the item stayed kind "voice" forever — never a task, never an event,
// never on a schedule — because the channel and the kind were the same variable, so every rule in
// the smart-capture path had to skip media captures entirely.
//
// These drive the real functions with a real transcript, with no model and no network: the local
// rules are what decide a plain "call Ravi tomorrow", and that is the case that has to work.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl, bootApp } from './test-server.mjs';

let PORT = 4413;

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
  page.setDefaultTimeout(6000);
  await bootApp(page, PORT);
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // Every item created here is thrown away by reloading, so nothing reaches a real account.
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  // Type a sentence into the capture sheet the way dictation does: it writes the transcript into the
  // same textarea and calls onCaptureInput(). That is the real path, not a stand-in for it.
  const dictate = (transcript) => page.evaluate(async (t) => {
    openCapture();
    await new Promise((r) => setTimeout(r, 120));
    // The person opened the capture sheet and chose the Voice chip, exactly as they would before
    // pressing record. Without this the channel stays "text" and the test proves nothing.
    pickType('voice', true);
    // This is exactly what stopVoiceDictation() leaves behind.
    const input = document.getElementById('captureText');
    input.value = t;
    onCaptureInput();
    // Long enough for the 700ms debounce and the local rules to settle.
    await new Promise((r) => setTimeout(r, 1100));
    return {
      channel: captureChannel,
      type: captureType,
      // The panel the person can still see — a re-typed capture must not hide the recorder.
      voicePanel: getComputedStyle(document.getElementById('voiceCaptureUI')).display,
      person: document.getElementById('capturePerson').value,
      due: document.getElementById('captureDueDate').value,
    };
  }, transcript);

  await check('a dictated "call Ravi tomorrow" is read as a task, not left as a voice note', async () => {
    const r = await dictate('call Ravi tomorrow');
    assert.equal(r.channel, 'voice', 'the capture must still be a voice capture');
    assert.equal(r.type, 'task', `"call Ravi tomorrow" stayed a ${r.type} instead of becoming a task`);
    assert.equal(r.person, 'Ravi', `the person was not picked out of the sentence (got "${r.person}")`);
    assert.ok(r.due, 'no date was pulled out of "tomorrow"');
  });

  await check('the recorder stays on screen after the capture is re-typed', async () => {
    // The audio is still attached, so hiding the panel would throw it away.
    const r = await dictate('call Ravi tomorrow');
    assert.notEqual(r.voicePanel, 'none', 're-typing hid the recorder, which would drop the audio');
  });

  await check('a dictated date reads as an event', async () => {
    // The local rules call something an event only when it carries both a time and an event word
    // ("meeting", "sync", …). This sentence has both. A phrase with only a time falls through to a
    // plain note until the model reads it — that is the local rule's job, and it is unchanged.
    const r = await dictate('design meeting tomorrow at 3pm');
    assert.equal(r.channel, 'voice', 'the capture must still be a voice capture');
    assert.equal(r.type, 'event', `expected an event, got ${r.type}`);
    assert.ok(r.due, 'the time was not read out of the sentence');
  });

  await check('a dictated sentence is never left as a voice note, whatever it says', async () => {
    // This is the regression itself, independent of which kind is chosen: no dictation may survive
    // as kind "voice", because that is what made the app only *store* a voice rather than act on it.
    for (const line of [
      'call Ravi tomorrow',
      'design meeting tomorrow at 3pm',
      'pay the electricity bill on friday',
      'think about the new office',
    ]) {
      const r = await dictate(line);
      assert.notEqual(r.type, 'voice', `"${line}" was left as a voice note`);
      assert.equal(r.channel, 'voice', `"${line}" lost its voice capture`);
    }
  });

  await check('text recognised from a picture is read the same way', async () => {
    const r = await page.evaluate(async () => {
      openCapture();
      await new Promise((res) => setTimeout(res, 120));
      pickType('image', true);
      // What runImageOcr() puts in the box once it has read the picture.
      document.getElementById('captureText').value = 'pay the electricity bill on friday';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 1100));
      return { channel: captureChannel, type: captureType };
    });
    assert.equal(r.channel, 'image', 'the capture must still be an image capture');
    assert.notEqual(r.type, 'image', 'text read out of a picture was left as a picture');
  });

  await check('a file and a link are deliberately left alone', async () => {
    // There is nothing in a file to read, and a link's text is a URL. Guessing here would be worse
    // than not trying, so these two stay as they arrived.
    const file = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      pickType('file', true);
      document.getElementById('captureText').value = 'invoice january';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 900));
      return { channel: captureChannel, type: captureType };
    });
    assert.equal(file.channel, 'file');
    assert.equal(file.type, 'file', 'a file has no text, so its kind must not be guessed');

    const link = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      pickType('link', true);
      document.getElementById('captureText').value = 'read this later';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 900));
      return { channel: captureChannel, type: captureType };
    });
    assert.equal(link.channel, 'link');
    assert.equal(link.type, 'link', 'a link was re-typed, which would hide the URL field');
  });

  await check('the channel resets, so the next capture starts clean', async () => {
    const r = await page.evaluate(async () => {
      openCapture();
      await new Promise((res) => setTimeout(res, 120));
      pickType('voice', true);
      openCapture();               // reopen without saving
      await new Promise((res) => setTimeout(res, 200));
      return {
        channel: captureChannel,
        type: captureType,
        voicePanel: getComputedStyle(document.getElementById('voiceCaptureUI')).display,
      };
    });
    assert.equal(r.channel, 'text', `the channel leaked into the next capture (${r.channel})`);
    assert.equal(r.type, 'text');
    assert.equal(r.voicePanel, 'none', 'the recorder stayed on screen for the next capture');
  });

  await check('a manual choice is still never overridden', async () => {
    // `manual` means the person picked the chip themselves. Nothing the app reads may undo that.
    const r = await page.evaluate(async () => {
      openCapture();
      await new Promise((res) => setTimeout(res, 120));
      pickType('task', true);       // the person chose Task
      document.getElementById('captureText').value = 'meet Ravi tomorrow';
      onCaptureInput();
      await new Promise((res) => setTimeout(res, 1100));
      return { type: captureType, autoDetected: captureAutoDetected };
    });
    assert.equal(r.autoDetected, true, 'a manual choice was forgotten');
    assert.equal(r.type, 'task', 'a manual choice was overridden by the reader');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nUNDERSTANDING CHECKS FAILED' : `\nALL ${results.length} UNDERSTANDING CHECKS PASSED`);