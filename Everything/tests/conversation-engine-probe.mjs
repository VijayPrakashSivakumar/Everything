// Proves the conversation engine: a sentence can be *finished* by answering, not by filling a form.
//
//   node Everything/tests/conversation-engine-probe.mjs
//
// What this exists for. The question card could only ever offer fixed buttons, so "Remind me to
// call Arun" could ask *whether* to keep it but never *when* — the only route to a date was the
// native date picker. This drives the real functions in a real browser, with no model and no
// network, and checks the exchange the product actually promises:
//
//   "Remind me to call Arun."  ->  "Sure. What date?"  ->  "Tomorrow"  ->  "What time?"
//                              ->  "10 AM"             ->  created
//
// It also pins the two ways this could quietly break everything else: a sentence that is *not*
// asking to be reminded must never open a conversation, and nothing here may block a save.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4417;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // Nothing created here reaches a real account.
  await page.evaluate(() => { window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }); });

  // Everything the probe asserts about the conversation, read in one go. It is a string because it
  // has to be evaluated inside the page, so it is passed across as an argument rather than closed
  // over. Every read is guarded, so a missing element reports itself instead of throwing and hiding
  // which field actually moved.
  const CARD = `({
    hidden: (document.getElementById('captureQuestion') || {}).hidden !== false,
    question: (document.querySelector('.capture-question-text') || {}).textContent || '',
    hasInput: !!document.getElementById('captureQuestionInput'),
    hasMic: !!document.getElementById('captureQuestionMic'),
    // A date picker would mean the form came back, which is the thing being removed.
    hasPicker: !!document.querySelector('.capture-question input[type=date], .capture-question input[type=datetime-local]'),
    due: (document.getElementById('captureDueDate') || {}).value || '',
    turns: [].slice.call(document.querySelectorAll('.capture-dialogue-turn')).map(function (el) { return el.textContent.trim(); }),
    answering: typeof captureDialogue !== 'undefined' && captureDialogue.answering,
    required: typeof captureDialogue !== 'undefined' ? [].slice.call(captureDialogue.required) : []
  })`;

  /* Every check is self-contained: it opens the sheet, says its sentence, waits past the 700ms
     debounce, and only then answers. Chaining them off whatever the previous check left on screen
     would make a failure depend on the order the checks ran in, which is exactly the kind of
     brittleness that makes a probe stop being evidence. */
  const say = (text) => page.evaluate(async (a) => {
    openCapture();
    await new Promise((r) => setTimeout(r, 120));
    document.getElementById('captureText').value = a[0];
    onCaptureInput();
    await new Promise((r) => setTimeout(r, 1100));
    return eval(a[1]);
  }, [text, CARD]);

  // Say a sentence, then answer whatever it is being asked, in free text.
  const answer = (text, words) => page.evaluate(async (a) => {
    openCapture();
    await new Promise((r) => setTimeout(r, 120));
    document.getElementById('captureText').value = a[0];
    onCaptureInput();
    await new Promise((r) => setTimeout(r, 1100));
    const input = document.getElementById('captureQuestionInput');
    if (!input) return { missing: true, ...eval(a[2]) };
    input.value = a[1];
    submitCaptureAnswer();
    return eval(a[2]);
  }, [text, words, CARD]);

  await check('a reminder with no date is asked for, in words, not with a date picker', async () => {
    const s = await say('Remind me to call Arun');
    assert.equal(s.hidden, false, 'the assistant must ask something');
    assert.match(s.question, /what date/i, `expected a date question, got "${s.question}"`);
    assert.equal(s.hasInput, true, 'there is nowhere to type an answer');
    assert.equal(s.hasMic, true, 'the answer must be speakable as well as typeable');
    assert.equal(s.hasPicker, false, 'a date picker is the form this replaces');
  });

  await check('"Tomorrow" fills the date and moves on to the time', async () => {
    const s = await answer('Remind me to call Arun', 'Tomorrow');
    assert.ok(s.due, 'the date field was left empty after answering "Tomorrow"');
    assert.equal(s.due.slice(0, 10), new Date(Date.now() + 864e5).toISOString().slice(0, 10),
      `"Tomorrow" became ${s.due}`);
    assert.match(s.question, /what time/i, `expected a time question, got "${s.question}"`);
    assert.equal(s.required.length, 1, 'only the time should still be outstanding');
  });

  await check('"10 AM" sets the clock time on the day already chosen', async () => {
    const s = await answer('Remind me to call Arun', 'Tomorrow at 10 am');
    assert.match(s.due, /T10:00$/, `expected 10:00, got "${s.due}"`);
    assert.deepEqual(s.required, [], 'nothing should still be outstanding');
    assert.equal(s.answering, false, 'the conversation should be finished');
  });

  await check('an answer that is not a date is refused, and the same question stays', async () => {
    const s = await answer('Remind me to call Arun', 'banana');
    assert.equal(s.answering, true, 'an unreadable answer must not end the conversation');
    assert.match(s.question, /what date/i, 'the same question must still be on screen');
    assert.ok(s.turns.some((t) => /could not read/i.test(t)),
      `nothing explained the refusal: ${JSON.stringify(s.turns)}`);
  });

  await check('"tomorrow at 4 pm" settles both at once and does not ask twice', async () => {
    const s = await answer('Remind me to call Arun', 'tomorrow at 4 pm');
    assert.match(s.due, /T16:00$/, `expected 16:00, got "${s.due}"`);
    assert.deepEqual(s.required, [], 'answering both halves must not leave a question behind');
    assert.equal(s.answering, false, 'the conversation should have finished');
  });

  await check('the exchange reads back as a conversation', async () => {
    const s = await answer('Remind me to call Arun', 'Tomorrow');
    assert.ok(s.turns.length >= 2, `expected a transcript, got ${JSON.stringify(s.turns)}`);
    assert.ok(s.turns.some((t) => /Tomorrow/.test(t)), 'the answer given is missing from the transcript');
    assert.ok(s.turns.some((t) => /Everything/.test(t)), 'the assistant never spoke');
  });

  await check('a sentence that is not a reminder is never asked anything', async () => {
    // The regression this feature could most easily cause: making every capture stop and ask would
    // break the silent auto-create that plain tasks and meetings already rely on.
    const s = await say('meeting with the design team tomorrow at 9am');
    assert.equal(s.hidden, true, `a plain meeting must not open a conversation (got "${s.question}")`);
    assert.equal(s.required.length, 0, 'no slot should be outstanding');
  });

  await check('a plain task with no date is never asked anything', async () => {
    const s = await say('buy milk');
    assert.equal(s.hidden, true, 'a task with no date is still a perfectly good task');
  });

  await check('dismissing ends the conversation and never blocks a save', async () => {
    const s = await page.evaluate(async (src) => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      document.getElementById('captureText').value = 'Remind me to call Arun';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      const before = { asking: captureDialogue.answering };
      dismissCaptureQuestion();
      return { before, after: eval(src) };
    }, CARD);
    assert.equal(s.before.asking, true, 'the conversation should have started');
    assert.equal(s.after.answering, false, 'dismiss must end the conversation');
    assert.deepEqual(s.after.required, [], 'dismiss must leave nothing outstanding');
    assert.equal(s.after.hidden, true, 'the card must be gone');
  });

  await check('editing the sentence resets the conversation rather than carrying an answer over', async () => {
    // Otherwise a date given about one sentence silently lands on a different one.
    const s = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      const input = document.getElementById('captureText');
      input.value = 'Remind me to call Arun';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      document.getElementById('captureQuestionInput').value = 'Tomorrow';
      submitCaptureAnswer();
      const afterFirst = Object.keys(captureDialogue.filled).length;
      input.value = 'Remind me to call Arun tomorrow at 4pm';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 300));
      return { afterFirst, after: Object.keys(captureDialogue.filled).length };
    });
    assert.equal(s.afterFirst, 1, 'the first answer should have been recorded');
    assert.equal(s.after, 0, 'an answer from the previous sentence leaked into the new one');
  });

  await check('the sentence being asked about is never overwritten by dictation', async () => {
    // The recogniser writes into the capture box by default. Mid-conversation that would destroy
    // the very sentence under discussion, so it is routed to the answer instead.
    const s = await page.evaluate(async () => {
      openCapture();
      await new Promise((r) => setTimeout(r, 120));
      const input = document.getElementById('captureText');
      input.value = 'Remind me to call Arun';
      onCaptureInput();
      await new Promise((r) => setTimeout(r, 1100));
      toggleVoiceDictation();
      await new Promise((r) => setTimeout(r, 200));
      const out = {
        // If the guard is missing this starts the *capture* recogniser instead.
        answerListening: captureAnswerActive,
        captureListening: captureVoiceActive,
        text: input.value,
      };
      stopCaptureAnswerDictation();
      stopVoiceDictation();
      return out;
    });
    assert.equal(s.text, 'Remind me to call Arun', 'the sentence was overwritten mid-conversation');
    assert.equal(s.captureListening, false, 'the capture recogniser must not start while answering');
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nCONVERSATION CHECKS FAILED' : `\nALL ${results.length} CONVERSATION CHECKS PASSED`);
