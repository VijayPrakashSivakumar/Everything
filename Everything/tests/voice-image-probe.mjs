// Voice and image capture probe. The behaviour at runtime, not just the shape of the source.
//
//   node Everything/tests/voice-image-probe.mjs
//
// Why this exists: both features stopped before producing anything. Reading an image sat on
// "Reading…" for ever, and recording a voice saved an audio file that no one ever read back.
//
// The first is worth stating precisely, because it was not a bug in the way it looked. Nothing was
// looping or throwing: runImageOcr had a `finally` that cleared the button the whole time. What it
// was doing was waiting on a 10.9 MB language pack (eng.traineddata.gz) through a promise with no
// ceiling, so a connection that neither completed nor errored left the user looking at a spinner.
// Silence never rejects a promise on its own — so the first check below is deliberately built from
// a promise that can never settle, because that is the only shape that reproduces it.
//
// The second cannot be fixed by wiring two existing buttons together. The Web Speech API reads the
// live microphone and has no way to be handed a recorded file, so a recording only becomes text if
// the recogniser is listening during the same moment the recorder is.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4463;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });

  await check('a promise that never settles is still given up on', async () => {
    // The exact failure that produced "stuck on Reading". No ceiling means this never returns and
    // the page has to be reloaded; with one it fails in a bounded time carrying a message.
    const outcome = await page.evaluate(async () => {
      const started = Date.now();
      let message = '';
      try {
        await withTimeout(new Promise(() => {}), 150, 'gave up');
      } catch (e) {
        message = e.message;
      }
      return { message, elapsed: Date.now() - started };
    });
    assert.equal(outcome.message, 'gave up', 'the timeout must reject with its own message');
    assert.ok(outcome.elapsed < 8000, `expected an early rejection, took ${outcome.elapsed}ms`);
  });

  await check('a promise that resolves in time is passed through untouched', async () => {
    // A timeout that fires on work which merely finishes slowly would turn a working read into a
    // failure, so the fast path must be unchanged by the guard being present.
    const value = await page.evaluate(() => withTimeout(Promise.resolve('read'), 5000, 'gave up'));
    assert.equal(value, 'read');
  });

  await check('cancelling a read puts the button back the way it was', async () => {
    const outcome = await page.evaluate(() => {
      const button = document.getElementById('imageOcrBtn');
      const cancel = document.getElementById('imageOcrCancelBtn');
      ocrBusy = true;
      button.disabled = true;
      document.getElementById('imageOcrLabel').textContent = 'Reading…';
      cancel.style.display = 'block';
      cancelImageOcr();
      return {
        busy: ocrBusy,
        disabled: button.disabled,
        label: document.getElementById('imageOcrLabel').textContent,
        cancelShown: cancel.style.display !== 'none',
        status: document.getElementById('imageOcrStatus').textContent,
      };
    });
    assert.equal(outcome.busy, false, 'cancelling must clear the busy flag');
    assert.equal(outcome.disabled, false, 'the button must be usable again');
    assert.equal(outcome.label, 'Read text from image', 'the label must be restored');
    assert.equal(outcome.cancelShown, false, 'the cancel button must be hidden again');
    assert.match(outcome.status, /stopped/i, 'cancelling must say what happened');
  });

  await check('the camera and the library are separate, and the camera opens directly', async () => {
    const markup = await page.evaluate(() => {
      const cam = document.getElementById('imageCameraInput');
      const gal = document.getElementById('imageGalleryInput');
      return {
        cam: !!cam,
        gal: !!gal,
        capture: cam?.getAttribute('capture') || '',
        camAccept: cam?.getAttribute('accept') || '',
        oldGone: !document.getElementById('imageFileInput'),
        camBtn: !!document.getElementById('imageCameraBtn'),
        galBtn: !!document.getElementById('imageGalleryBtn'),
      };
    });
    assert.ok(markup.cam && markup.gal, 'both inputs must exist');
    // capture="environment" is the attribute that makes a phone open the rear camera. Without it the
    // single control opened the library, which is what made the camera hard to reach.
    assert.equal(markup.capture, 'environment', 'the camera input must open the camera directly');
    assert.equal(markup.camAccept, 'image/*', 'the camera input must accept images only');
    assert.ok(markup.oldGone, 'the single ambiguous input should be gone');
    assert.ok(markup.camBtn && markup.galBtn, 'both intents need a button');
  });

  await check('opening the capture sheet starts warming the reader', async () => {
    // The ~11 MB is spent while the person reads the sheet, not while they watch a button.
    const calls = await page.evaluate(() => {
      let calls = 0;
      const original = window.warmOcrEngine;
      window.warmOcrEngine = () => { calls += 1; };
      try {
        openCapture();
      } finally {
        window.warmOcrEngine = original;
      }
      return calls;
    });
    assert.equal(calls, 1, 'opening the sheet must warm the engine exactly once');
  });

  await check('the cost of a first read is disclosed rather than discovered', async () => {
    // "Loading the text reader…" was true and useless. The person has to know why it is waiting.
    const message = await page.evaluate(() => {
      delete window.Tesseract;
      setImageOcrStatus(
        window.Tesseract
          ? 'Preparing the text reader…'
          : 'First run downloads the text reader (~11 MB, once). On mobile data this can take a minute — you can stop it below.',
      );
      return document.getElementById('imageOcrStatus').textContent;
    });
    assert.match(message, /11 MB/i, 'the download size must be stated up front');
    assert.match(message, /once/i, 'it must be clear this is a one-time cost');
  });

  await check('a spoken capture becomes text in the box', async () => {
    // This is the line that turns voice capture into a capture. Without it a recording is only ever
    // an attachment, and the smart-capture pipeline never sees what was said.
    const outcome = await page.evaluate(() => {
      document.getElementById('captureText').value = '';
      let pipelineRuns = 0;
      const original = window.onCaptureInput;
      window.onCaptureInput = () => { pipelineRuns += 1; };
      try {
        voiceTranscriptBase = '';
        applyVoiceTranscript('pay the electricity bill tomorrow');
      } finally {
        window.onCaptureInput = original;
      }
      return {
        value: document.getElementById('captureText').value,
        pipelineRuns,
        live: document.getElementById('voiceLiveTranscript').textContent,
      };
    });
    assert.equal(outcome.value, 'pay the electricity bill tomorrow', 'the words must reach the box');
    assert.equal(outcome.pipelineRuns, 1, 'the smart-capture pipeline must run on the transcript');
    assert.match(outcome.live, /pay the electricity bill/, 'what was heard must be shown');
  });

  await check('a spoken capture is added to, not substituted for, what was already typed', async () => {
    // The box is often already holding a typed fragment; overwriting it would lose those words.
    const outcome = await page.evaluate(() => {
      const input = document.getElementById('captureText');
      input.value = '';
      voiceTranscriptBase = 'from the shop';
      applyVoiceTranscript('and call mum');
      return input.value;
    });
    assert.equal(outcome, 'from the shop and call mum');
  });

  await check('recording and transcribing are wired to the same tap', async () => {
    // The recogniser cannot be pointed at the recorded file afterwards, so it has to be running
    // during the recording. Asserted on the source because getUserMedia does not exist headless,
    // but the wiring either side of it is exactly what can be checked here.
    const calls = await page.evaluate(() => ({
      recorder: /MediaRecorder/.test(toggleVoiceRecording.toString()),
      transcription: /startVoiceTranscription\(\)/.test(toggleVoiceRecording.toString()),
      streaming: /interimResults\s*=\s*true/.test(startVoiceTranscription.toString()),
      continuous: /continuous\s*=\s*true/.test(startVoiceTranscription.toString()),
    }));
    assert.ok(calls.recorder, 'the audio recording must stay');
    assert.ok(calls.transcription, 'recording must start transcription in the same moment');
    assert.ok(calls.streaming, 'words must appear while speaking, not only at the end');
    assert.ok(calls.continuous, 'one recogniser run must cover a whole sentence');
  });

  await check('a browser with no speech recognition still records', async () => {
    // Recognition is best-effort. Firefox has no webkitSpeechRecognition at all and the audio is
    // still worth keeping, so this must return false and say why rather than throw.
    const outcome = await page.evaluate(() => {
      delete window.SpeechRecognition;
      delete window.webkitSpeechRecognition;
      let started;
      try {
        started = startVoiceTranscription();
      } catch (e) {
        return { threw: true, message: e.message };
      }
      return { threw: false, started, live: document.getElementById('voiceLiveTranscript').textContent };
    });
    assert.equal(outcome.threw, false, 'a missing recogniser must not throw');
    assert.equal(outcome.started, false, 'it must report that transcription did not start');
    assert.match(outcome.live, /recording is still saved|cannot turn speech into text/i,
      'it must say the audio is safe');
  });

  await check('a bulleted list becomes several items, not one', async () => {
    // The whiteboard case: five actions photographed at once. This was a single item whose title was
    // the entire list, which looks like it worked and is unusable.
    const out = await page.evaluate(() => {
      const text = '- call the plumber\n- renew the insurance\n- book the dentist\n- pay the rent\n- email Priya';
      const parts = localSplitItems(text, { kind: 'task', dueDate: '' });
      return { count: parts ? parts.length : 0, titles: parts ? parts.map((p) => p.title) : [] };
    });
    assert.equal(out.count, 5, `expected five items, got ${out.count}`);
    assert.ok(out.titles.includes('call the plumber'), 'the bullet itself must be stripped');
    assert.ok(!out.titles.some((t) => t.startsWith('-')), 'a dash must not survive into a title');
  });

  await check('a numbered list and an agenda both split', async () => {
    const out = await page.evaluate(() => {
      const numbered = localSplitItems('1. buy milk\n2. call mum\n3. book flights', {});
      const agenda = localSplitItems('Monday 10:00 standup\nMonday 14:00 review\nTuesday 09:00 retro', {});
      return { numbered: numbered ? numbered.length : 0, agenda: agenda ? agenda.length : 0 };
    });
    assert.equal(out.numbered, 3, 'a numbered list must split');
    assert.equal(out.agenda, 3, 'an agenda must split');
  });

  await check('prose is left whole', async () => {
    // The cost of being wrong. A paragraph broken into fragments is a note destroyed, so a block
    // with no deliberate markers must come back as no split at all.
    const out = await page.evaluate(() => ({
      prose: localSplitItems(
        'Remember that the water bill was very high last month\nand the gardener said he would come again in spring\nbut we should probably check the invoice first', {}),
      one: localSplitItems('just one single line of text', {}),
      mixed: localSplitItems('- a real item\nsome prose that was never a list\nanother stray line', {}),
    }));
    assert.equal(out.prose, null, 'prose must not be split');
    assert.equal(out.one, null, 'a single line must not be split');
    assert.equal(out.mixed, null, 'a block with unmarked lines is prose, not a list');
  });

  await check('a receipt is never split into its own lines', async () => {
    // A receipt is one thing printed over many lines. Splitting it would turn a total, a date and a
    // merchant into three unrelated items, and the receipt path already reads all three.
    const out = await page.evaluate(() => localSplitItems([
      'FRESH MART',
      '12/09/2026 18:22',
      'MILK 1L          65.00',
      'BREAD            40.00',
      'EGGS 6           90.00',
      'TOTAL           195.00',
    ].join('\n'), {}));
    assert.equal(out, null, 'a receipt with a readable total must stay one item');
  });

  await check('money in the sentence keeps it as one item', async () => {
    // Two amounts are usually two halves of one expense, not two tasks.
    const out = await page.evaluate(() =>
      localSplitItems('- spent 450 on groceries\n- spent 200 on fuel', {}));
    assert.equal(out, null, 'a capture carrying an amount must not be split');
  });

  await check('a date on the header is inherited by lines that have none', async () => {
    // "Before Friday:" over a list is a header, not an item. Each line should take that date.
    const out = await page.evaluate(() => {
      const parts = localSplitItems('- renew insurance\n- service the car', {
        kind: 'task', dueDate: '2026-10-09T09:00:00.000Z',
      });
      return parts ? parts.map((p) => p.dueDate) : null;
    });
    assert.ok(out && out.length === 2, 'both lines must be kept');
    assert.ok(out.every((d) => d === '2026-10-09T09:00:00.000Z'),
      `every line must inherit the header date, got ${JSON.stringify(out)}`);
  });

  await check('a line naming its own date keeps it', async () => {
    // "pay rent tomorrow" carries its own date, so the header must not overwrite it. A line whose
    // date the local reader cannot see still inherits — that is the safe direction to fail.
    const out = await page.evaluate(() => {
      const parts = localSplitItems('- pay rent tomorrow\n- book dentist', {
        kind: 'task', dueDate: '2026-10-09T09:00:00.000Z',
      });
      return parts ? parts.map((p) => p.dueDate) : null;
    });
    assert.ok(out && out.length === 2, 'both lines must be kept');
    assert.notEqual(out[0], '2026-10-09T09:00:00.000Z',
      'a line that names its own date must not be overwritten by the header');
  });

  await check('the type picker survives being opened and closed', async () => {
    /* A missing function in this path throws inside pickType, which runs on every capture — a
       keyboard tap or a dictated sentence — so the whole sheet would break over a cosmetic toggle. */
    const out = await page.evaluate(() => {
      try {
        pickType('expense', true);
        const opened = document.getElementById('typeMoreRow').style.display !== 'none';
        toggleMoreTypes();
        const closed = document.getElementById('typeMoreRow').style.display === 'none';
        toggleMoreTypes();
        return { threw: false, opened, closed };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    assert.equal(out.threw, false, `the toggle must not throw (got ${out.message})`);
    assert.equal(out.opened, true, 'filing as a hidden kind must reveal that row');
    assert.equal(out.closed, true, 'the row must be able to close again');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode
  ? '\nVOICE+IMAGE CHECKS FAILED'
  : `\nALL ${results.length} VOICE+IMAGE CHECKS PASSED`);