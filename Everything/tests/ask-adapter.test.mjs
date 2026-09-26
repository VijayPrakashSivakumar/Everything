// Offline test for the Ask provider adapter (../api/ask.js). Runs the real `complete()` against
// a mock transport, so fallback, the shared time budget, and the reason trail are verified
// without spending a real API key or needing a login.
//
//   node Everything/tests/ask-adapter.test.mjs
//
// This lives outside api/ on purpose: every file in api/ is built as a Vercel function, and the
// project is already at the Hobby plan's 12-function limit.
import assert from 'node:assert/strict';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
}

const realFetch = globalThis.fetch;
let handler = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
let seen = [];

// Mock transport: records the call and returns whatever the scenario dictates. Exposed as a
// function so an individual test can swap it out and put the shared one back afterwards.
function installMockFetch() {
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const r = handler(String(url), seen.length);
    const status = r.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body || {} };
  };
}
installMockFetch();

const ENV_KEYS = [
  'AI_PROVIDER', 'GROQ_API_KEY', 'GROQ_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL',
];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function setEnv(next) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, next);
}

const { complete, aiStatus, probeProvider, parseExtraction, buildExtractionPrompt, resetFailureMemory } = await import('../api/ask.js');

// Every scenario starts with an empty provider-failure memory. The adapter deliberately remembers
// which providers just failed so it can skip them, and that memory is module state shared across
// tests — without this reset one test's failure silently changes the next test's provider order.
function freshEnv(next) {
  resetFailureMemory();
  setEnv(next);
}

await check('primary success returns the answer and calls nothing else', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'Pay it Friday.' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'Pay it Friday.');
  assert.equal(r.provider, 'groq');
  assert.equal(seen.length, 1, 'must not call a fallback on success');
});

await check('429 on the primary falls back to the next configured provider', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { choices: [{ message: { content: 'From Groq.' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'From Groq.');
  assert.equal(r.provider, 'groq');
  assert.equal(seen.length, 2);
});

await check('401 is not retried elsewhere and reports an actionable reason', async () => {
  freshEnv({ GEMINI_API_KEY: 'bad', GROQ_API_KEY: 'k' });
  seen = [];
  handler = () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, undefined);
  assert.equal(r.status, 502);
  assert.equal(r.reason, 'gemini:401');
  assert.equal(seen.length, 1, 'a bad key must not be retried on another provider');
});

/* Regression guard for the live bug the probe exposed: Groq returned HTTP 200 with an empty
   `content` because GPT-OSS is a reasoning model and the token budget went to `reasoning`.
   The old parser read only `content`, so a successful call was reported as "groq:empty". */
await check('a reasoning model that spends its budget returns a usable answer', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  handler = () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: '', reasoning: 'The user wants ok.' } }] },
  });
  const r = await complete({ prompt: 'q', maxTokens: 64 });
  assert.ok(r.answer, 'the reasoning text must be used when content is empty');
  assert.match(r.answer, /ok/);
  assert.equal(seen.length, 1, 'an answer found in reasoning must not trigger a fallback');
});

/* Regression: the live app ran with a dead primary and a working fallback, and the health probe
   reported `ok: true, provider: "groq"` because it only ever described whoever answered last.
   Gemini was failing on every request while the probe looked completely healthy. `trace` makes a
   successful-but-degraded result say so. */
const GEMINI_OK = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
const GROQ_OK = { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };

await check('trace reports a silent fallback as degraded, not as a clean success', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  // 429 is retryable, so the adapter is expected to fall through to groq.
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'resource exhausted' } } }
    : GROQ_OK);
  const r = await complete({ prompt: 'q', trace: true });
  assert.equal(r.answer, 'ok', 'the fallback still answers');
  assert.equal(r.provider, 'groq');
  assert.equal(r.degraded, true, 'a fallback answer must be flagged as degraded');
  assert.ok(Array.isArray(r.attempted) && r.attempted.length > 0, 'the primary failure must be listed');
  assert.match(r.attempted[0], /^gemini:/, 'the failure must name the provider that failed');
});

await check('a clean primary success is not reported as degraded', async () => {
  freshEnv({ GEMINI_API_KEY: 'g' });
  seen = [];
  handler = () => GEMINI_OK;
  const r = await complete({ prompt: 'q', trace: true });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.degraded, false, 'a healthy primary must not be flagged');
  assert.deepEqual(r.attempted, [], 'nothing should be listed as attempted');
});

await check('without trace the result shape is unchanged', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 400, body: { error: { message: 'bad key' } } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal('attempted' in r, false, 'attempted must be opt-in, not added to every response');
  assert.equal('degraded' in r, false, 'degraded must be opt-in too');
});

await check('a provider that just failed is skipped on the next call', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });

  // First call: Gemini fails, so the caller pays for the failure once.
  await complete({ prompt: 'q' });
  assert.equal(seen.filter((u) => u.includes('googleapis')).length, 1, 'first call tries Gemini');

  // Second call: Gemini is skipped entirely, so the user is not billed the latency twice.
  seen = [];
  await complete({ prompt: 'q' });
  assert.equal(seen.filter((u) => u.includes('googleapis')).length, 0,
    'a provider that just failed must not be tried again immediately');
  assert.equal(seen.length, 1, 'the fallback still answers');
});

await check('the skip expires on its own, so a fixed key recovers without a redeploy', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  await complete({ prompt: 'q' });  // gemini fails and is remembered
  await complete({ prompt: 'q' });  // gemini skipped
  seen = [];
  await complete({ prompt: 'q' });
  assert.equal(seen.filter((u) => u.includes('googleapis')).length, 0, 'skipped while cooling down');

  // Simulate the cooldown lapsing. Real deployments get this for free from the clock, so a key
  // fixed in Vercel starts being used again within minutes with no redeploy and no manual reset.
  resetFailureMemory();
  handler = () => GEMINI_OK;
  seen = [];
  const r = await complete({ prompt: 'q' });
  assert.equal(r.provider, 'gemini', 'the recovered provider is preferred again');
  assert.equal(seen.length, 1, 'and it answers on the first attempt');
});

await check('every provider cooling down still falls back to trying them', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  await complete({ prompt: 'q' });   // gemini remembered as failing
  // Now make groq fail too, so both providers are on record. Giving up would be worse than retrying.
  handler = () => ({ status: 500, body: { error: { message: 'server error' } } });
  const r = await complete({ prompt: 'q' });
  assert.ok(seen.length >= 2, 'a remembered failure must not reduce the chain to nothing');
  assert.equal(r.answer, undefined, 'both really are failing, so no answer is correct');
});

await check('a provider that succeeds has its failure record cleared', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  await complete({ prompt: 'q' });            // gemini fails -> recorded
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  seen = [];
  await complete({ prompt: 'q' });            // groq alone, gemini skipped
  // If gemini is still in the map but groq was the one that succeeded, the map must not be cleared
  // wholesale: groq succeeding says nothing about gemini.
  assert.equal(seen.filter((u) => u.includes('googleapis')).length, 0, 'gemini stays skipped');
});

await check('the parser handles every known response shape', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  const shape = async (body) => {
    seen = [];
    handler = () => ({ status: 200, body });
    const r = await complete({ prompt: 'q' });
    return r.answer || '';
  };
  assert.equal(await shape({ choices: [{ message: { content: 'direct' } }] }), 'direct', 'plain content');
  assert.equal(await shape({ choices: [{ message: { content: '', reasoning: 'thought' } }] }), 'thought', 'reasoning fallback');
  assert.equal(await shape({ choices: [{ text: 'legacy' }] }), 'legacy', 'legacy completions shape');
  assert.equal(await shape({ choices: [{ delta: { content: 'streamed' } }] }), 'streamed', 'delta shape');
  assert.equal(await shape({ choices: [{ message: { content: '   ', reasoning: 'thought' } }] }), 'thought', 'blank content');
  // A genuinely empty response stays empty so the fallback logic still runs.
  assert.equal(await shape({ choices: [{ message: { content: '', reasoning: '' } }] }), '', 'truly empty stays empty');
  // Non-string content must not throw or stringify into "[object Object]".
  assert.equal(await shape({ choices: [{ message: { content: null, reasoning: 'safe' } }] }), 'safe', 'null content');
});

await check('GPT-OSS models request light reasoning so the budget survives', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  let sent = '';
  try {
    globalThis.fetch = async (url, init) => {
      seen.push(String(url));
      sent = String(init.body || '');
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    await complete({ prompt: 'q' });
    const body = JSON.parse(sent);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.reasoning_effort, 'low', 'a GPT-OSS model must be asked for light reasoning');

    // A non-reasoning model must not receive the parameter, which some providers reject.
    freshEnv({ GROQ_API_KEY: 'k', GROQ_MODEL: 'llama-3.3-70b-versatile' });
    sent = '';
    await complete({ prompt: 'q' });
    assert.equal(JSON.parse(sent).reasoning_effort, undefined, 'non-reasoning models must not get reasoning_effort');
  } finally {
    installMockFetch();
  }
});

await check('a successful but empty completion is treated as failure and retried', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 200, body: { candidates: [{ content: { parts: [{ text: '   ' }] } }] } }
    : { status: 200, body: { choices: [{ message: { content: 'Recovered.' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'Recovered.');
  assert.equal(seen.length, 2);
});

await check('every provider failing reports the whole trail', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis') ? { status: 429, body: {} } : { status: 503, body: {} });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.status, 502);
  assert.equal(r.reason, 'gemini:429 -> groq:503');
});

await check('no keys configured is a 503 and contacts nobody', async () => {
  freshEnv({});
  seen = [];
  handler = () => ({ status: 200, body: {} });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.status, 503);
  assert.equal(r.reason, 'not-configured');
  assert.equal(seen.length, 0, 'must not call a provider without a key');
});

// Regression guard: a hung provider must not push the function past the platform duration
// limit, and the request must be aborted rather than left dangling.
await check('a hung provider stays inside the total budget and aborts the socket', async () => {
  freshEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  let abortSeen = false;
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => { abortSeen = true; reject(new Error('aborted')); });
  });
  const t0 = Date.now();
  const r = await complete({ prompt: 'q' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 12000, `took ${elapsed}ms, which would exceed the platform limit`);
  assert.equal(r.status, 502);
  assert.match(r.reason, /timeout|network|budget/, `unexpected reason: ${r.reason}`);
  assert.equal(abortSeen, true, 'the fetch signal must be aborted so the socket is released');
  // Restore the shared mock so later scenarios are not left with the hanging transport.
  installMockFetch();
});

await check('aiStatus reports the primary and the configured fallbacks', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  const s = aiStatus();
  assert.equal(s.configured, true);
  // Gemini is the default primary: its free tier allows far more tokens, and Ask now also
  // spends the model on smart-capture extraction.
  assert.equal(s.provider, 'gemini');
  assert.equal(s.model, 'gemini-flash-latest');
  assert.deepEqual(s.fallbacks, ['groq/openai/gpt-oss-120b']);
});

/* The live probe is how a provider is verified for real, rather than trusting that a key exists.
   A key can be present and still be rejected, which is exactly how a broken provider hid for so
   long: /api/health reported "ready" while every real completion failed. */
await check('probeProvider reports a working provider, a failure, and an unconfigured state', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  const good = await probeProvider();
  assert.equal(good.ok, true, 'a successful completion must be reported as ok');
  assert.equal(good.provider, 'groq');
  assert.equal(good.model, 'openai/gpt-oss-120b');
  assert.equal(good.sample, 'ok');
  assert.equal(typeof good.durationMs, 'number');

  // A rejected key must surface as a failure with a usable reason, never a false "ok".
  handler = () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  const bad = await probeProvider();
  assert.equal(bad.ok, false, 'a 401 must never be reported as a working provider');
  assert.equal(bad.reason, 'groq:401');
  assert.equal(bad.sample, null, 'no sample text may be invented on failure');

  // Unconfigured must be distinguishable from a failed call.
  freshEnv({});
  const none = await probeProvider();
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'not-configured');
});

/* The live bug this whole feature exists for: the probe answered "ok" and named the fallback,
   so /api/health looked completely healthy while the primary was failing on every request. */
await check('the probe cannot report a working fallback as a healthy app', async () => {
  freshEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'k' });
  seen = [];
  handler = (url) => (url.includes('googleapis')
    ? { status: 429, body: { error: { message: 'resource exhausted' } } }
    : GROQ_OK);
  const p = await probeProvider();
  assert.equal(p.ok, true, 'the fallback genuinely answers, so ok stays true');
  assert.equal(p.provider, 'groq', 'it names whoever actually answered');
  // These three are what make the failure impossible to miss from the outside.
  assert.equal(p.configuredProvider, 'gemini', 'it also names who was meant to answer');
  assert.notEqual(p.configuredProvider, p.provider, 'a silent fallback must be visible');
  assert.equal(p.degraded, true, 'and it must not look like a clean success');
  assert.match(p.attempted[0], /^gemini:/, 'with the primary failure reason listed');
});

await check('the probe reports a healthy primary as not degraded', async () => {
  freshEnv({ GEMINI_API_KEY: 'g' });
  seen = [];
  handler = () => GEMINI_OK;
  const p = await probeProvider();
  assert.equal(p.ok, true);
  assert.equal(p.provider, 'gemini');
  assert.equal(p.configuredProvider, 'gemini', 'the intended provider did answer');
  assert.equal(p.degraded, false, 'a healthy app must not be flagged degraded');
  assert.deepEqual(p.attempted, []);
});

await check('the probe stays cheap and sends no user data', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  let sentBody = '';
  // try/finally: if an assertion below throws, the shared transport must still be restored,
  // or the failure leaks into every later test and hides the real cause.
  try {
    globalThis.fetch = async (url, init) => {
      seen.push(String(url));
      sentBody = init && init.body ? String(init.body) : '';
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    await probeProvider();
    const body = JSON.parse(sentBody);
    // 64 leaves room for a reasoning model's hidden tokens; a 200 with an empty body would
    // otherwise be indistinguishable from a broken provider.
    assert.equal(body.max_tokens, 64, 'the probe must request a small but usable budget');
    assert.ok(body.max_tokens <= 128, 'the probe must stay cheap');
    assert.equal(body.messages.length, 1, 'the probe must be a single fixed request');
    assert.match(body.messages[0].content, /single word/, 'the probe prompt must be the fixed ping');
    assert.doesNotMatch(sentBody, /invoice|manoj|capture|household/i, 'the probe must not carry user data');
  } finally {
    installMockFetch();
  }
});

/* The empty-200 shape is what makes the provider diagnosable from outside the function, so it
   must be safe: structure and lengths only, never values and never anything key-derived. */
await check('an empty completion reports the response shape, never its contents', async () => {
  freshEnv({ GROQ_API_KEY: 'sk-super-secret-value' });
  handler = () => ({
    status: 200,
    body: {
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: '', refusal: 'private-detail-here' },
      }],
      id: 'req-123',
    },
  });
  const r = await complete({ prompt: 'q', maxTokens: 16 });
  assert.equal(r.answer, undefined);
  assert.equal(r.reason, 'groq:empty');
  assert.ok(r.shapes && r.shapes.length, 'a shape must be attached to an empty result');
  const shape = r.shapes[0];
  assert.equal(shape.finishReason, 'length', 'the finish reason is the key clue');
  assert.equal(shape.choices, 1);
  assert.ok(shape.messageKeys.includes('content'), 'the message keys must be listed');
  assert.match(String(shape.content), /^string\(0\)$/, 'content is reported as a length, not a value');

  const serialised = JSON.stringify(r);
  assert.doesNotMatch(serialised, /sk-super-secret-value/, 'the API key must never be reported');
  assert.doesNotMatch(serialised, /private-detail-here/, 'field values must never be reported');
});

await check('probeProvider surfaces the upstream shape on failure', async () => {
  freshEnv({ GROQ_API_KEY: 'k' });
  handler = () => ({ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '' } }] } });
  const bad = await probeProvider();
  assert.equal(bad.ok, false);
  assert.ok(bad.shapes && bad.shapes.length, 'the probe must expose the shape');
  assert.equal(bad.shapes[0].finishReason, 'length');
  // A success must not carry a shape, so the field only appears when it means something.
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  const good = await probeProvider();
  assert.equal(good.ok, true);
  assert.equal(good.shapes, undefined, 'a working provider must not report a shape');
});

await check('an explicit AI_PROVIDER pins the primary', async () => {
  freshEnv({ AI_PROVIDER: 'gemini', GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = (url) => (url.includes('groq')
    ? { status: 200, body: { choices: [{ message: { content: 'wrong provider' } }] } }
    : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Pinned.' }] } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.answer, 'Pinned.');
});

/* ---------- Smart-capture extraction ----------
   The capture sheet writes this straight into the form, so a hallucinated kind, a bogus date or
   an unexpected priority must be rejected rather than rendered. */
await check('capture extraction reads a clean JSON reply', async () => {
  const parsed = parseExtraction('{"kind":"task","title":"Call Ravi about the quote","dueDate":"2026-09-26T10:00:00.000Z","person":"Ravi","project":"Atlas","priority":"high","recurrence":"none","confidence":"high","ambiguous":""}');
  assert.equal(parsed.kind, 'task');
  assert.equal(parsed.title, 'Call Ravi about the quote');
  assert.equal(parsed.person, 'Ravi');
  assert.equal(parsed.priority, 'high');
  assert.equal(parsed.recurrence, 'none');
  assert.equal(parsed.confidence, 'high');
});

await check('capture extraction survives code fences and surrounding prose', async () => {
  const parsed = parseExtraction('Sure! Here you go:\n```json\n{"kind":"waiting","title":"Drawings from Ravi","dueDate":"","person":"Ravi","project":"","priority":"","recurrence":"none","confidence":"medium","ambiguous":"Which project?"}\n```\nHope that helps.');
  assert.equal(parsed.kind, 'waiting', 'a fenced reply must still parse');
  assert.equal(parsed.ambiguous, 'Which project?');
  // A missing field must become a known-safe value, never undefined.
  assert.equal(parsed.dueDate, '');
  assert.equal(parsed.priority, '');
});

await check('capture extraction rejects values the form cannot represent', async () => {
  const parsed = parseExtraction('{"kind":"spaceship","title":"x","priority":"catastrophic","recurrence":"fortnightly","confidence":"certain","dueDate":12345}');
  assert.equal(parsed.kind, '', 'an unknown kind must be dropped, not passed through');
  assert.equal(parsed.priority, '', 'an unknown priority must be dropped');
  assert.equal(parsed.recurrence, 'none', 'an unknown recurrence falls back to none');
  assert.equal(parsed.confidence, 'medium', 'an unknown confidence falls back to medium');
  assert.equal(parsed.dueDate, '', 'a non-string date must be dropped');
});

await check('capture extraction rejects unusable replies without throwing', async () => {
  for (const bad of ['', '   ', 'not json at all', '{ "kind": "task"', '[1,2,3]', 'null', '"a string"']) {
    assert.equal(parseExtraction(bad), null, `must be null for: ${JSON.stringify(bad)}`);
  }
});

await check('the extraction prompt refuses to invent a date and carries the date', async () => {
  const prompt = buildExtractionPrompt('Maybe Friday about the quote', 'Friday, September 25, 2026');
  assert.match(prompt, /Friday, September 25, 2026/, 'the current date must reach the model');
  assert.match(prompt, /Never invent a date/i, 'the prompt must forbid inventing a date');
  assert.match(prompt, /Maybe Friday about the quote/, 'the sentence must be included');
  assert.match(prompt, /waiting/, 'the prompt must explain the non-task kinds');
  assert.match(prompt, /openloop/, 'the prompt must explain open loops');
});

await check('the Gemini path is a working default, not just a reordered list', async () => {
  // Guards the change that made Gemini primary: it must be tried first, must speak its own
  // response shape, and must not carry an OpenAI-only parameter.
  freshEnv({ GEMINI_API_KEY: 'g' });
  seen = [];
  let sent = '';
  try {
    globalThis.fetch = async (url, init) => {
      seen.push(String(url));
      sent = String(init.body || '');
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Gemini answered.' }] } }] }) };
    };
    const r = await complete({ prompt: 'q' });
    assert.equal(r.provider, 'gemini');
    assert.equal(r.answer, 'Gemini answered.');
    assert.equal(seen.length, 1, 'Gemini must answer without needing a fallback');
    assert.match(seen[0], /generativelanguage\.googleapis\.com/, 'it must call the Gemini endpoint');
    assert.match(seen[0], /gemini-flash-latest/, 'it must use the free-tier model');
    const body = JSON.parse(sent);
    assert.equal(body.generationConfig.temperature, 0.2, 'Gemini takes generationConfig, not top-level temperature');
    assert.equal(body.temperature, undefined, 'a top-level temperature would be ignored by Gemini');
    assert.equal(body.reasoning_effort, undefined, 'reasoning_effort is OpenAI-only and must not be sent');
    assert.equal(body.messages, undefined, 'Gemini takes contents, not messages');
  } finally {
    installMockFetch();
  }
});

await check('an OpenAI-style reply is never trusted from the Gemini path', async () => {
  // A cross-wired or misconfigured proxy must not be able to make the parser read the wrong field.
  freshEnv({ GEMINI_API_KEY: 'g' });
  seen = [];
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'wrong shape' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, undefined, 'a non-Gemini shape must not be read as a Gemini answer');
});

for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}
globalThis.fetch = realFetch;

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nALL ${results.length} TESTS PASSED`);

