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

const { complete, aiStatus, probeProvider } = await import('../api/ask.js');

await check('primary success returns the answer and calls nothing else', async () => {
  setEnv({ GROQ_API_KEY: 'k' });
  seen = [];
  handler = () => ({ status: 200, body: { choices: [{ message: { content: 'Pay it Friday.' } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'Pay it Friday.');
  assert.equal(r.provider, 'groq');
  assert.equal(seen.length, 1, 'must not call a fallback on success');
});

await check('429 on the primary falls back to the next configured provider', async () => {
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = (url) => (url.includes('groq')
    ? { status: 429, body: { error: { message: 'rate limited' } } }
    : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'From Gemini.' }] } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'From Gemini.');
  assert.equal(r.provider, 'gemini');
  assert.equal(seen.length, 2);
});

await check('401 is not retried elsewhere and reports an actionable reason', async () => {
  setEnv({ GROQ_API_KEY: 'bad', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = () => ({ status: 401, body: { error: { message: 'Invalid API Key' } } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, undefined);
  assert.equal(r.status, 502);
  assert.equal(r.reason, 'groq:401');
  assert.equal(seen.length, 1, 'a bad key must not be retried on another provider');
});

/* Regression guard for the live bug the probe exposed: Groq returned HTTP 200 with an empty
   `content` because GPT-OSS is a reasoning model and the token budget went to `reasoning`.
   The old parser read only `content`, so a successful call was reported as "groq:empty". */
await check('a reasoning model that spends its budget returns a usable answer', async () => {
  setEnv({ GROQ_API_KEY: 'k' });
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

await check('the parser handles every known response shape', async () => {
  setEnv({ GROQ_API_KEY: 'k' });
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
  setEnv({ GROQ_API_KEY: 'k' });
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
    setEnv({ GROQ_API_KEY: 'k', GROQ_MODEL: 'llama-3.3-70b-versatile' });
    sent = '';
    await complete({ prompt: 'q' });
    assert.equal(JSON.parse(sent).reasoning_effort, undefined, 'non-reasoning models must not get reasoning_effort');
  } finally {
    installMockFetch();
  }
});

await check('a successful but empty completion is treated as failure and retried', async () => {
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = (url) => (url.includes('groq')
    ? { status: 200, body: { choices: [{ message: { content: '   ' } }] } }
    : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Recovered.' }] } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.answer, 'Recovered.');
  assert.equal(seen.length, 2);
});

await check('every provider failing reports the whole trail', async () => {
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = (url) => (url.includes('groq') ? { status: 429, body: {} } : { status: 503, body: {} });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.status, 502);
  assert.equal(r.reason, 'groq:429 -> gemini:503');
});

await check('no keys configured is a 503 and contacts nobody', async () => {
  setEnv({});
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
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
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
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  const s = aiStatus();
  assert.equal(s.configured, true);
  assert.equal(s.provider, 'groq');
  assert.equal(s.model, 'openai/gpt-oss-120b');
  assert.deepEqual(s.fallbacks, ['gemini/gemini-flash-latest']);
});

/* The live probe is how a provider is verified for real, rather than trusting that a key exists.
   A key can be present and still be rejected, which is exactly how a broken provider hid for so
   long: /api/health reported "ready" while every real completion failed. */
await check('probeProvider reports a working provider, a failure, and an unconfigured state', async () => {
  setEnv({ GROQ_API_KEY: 'k' });
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
  setEnv({});
  const none = await probeProvider();
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'not-configured');
});

await check('the probe stays cheap and sends no user data', async () => {
  setEnv({ GROQ_API_KEY: 'k' });
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

await check('an explicit AI_PROVIDER pins the primary', async () => {
  setEnv({ AI_PROVIDER: 'gemini', GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  seen = [];
  handler = (url) => (url.includes('groq')
    ? { status: 200, body: { choices: [{ message: { content: 'wrong provider' } }] } }
    : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Pinned.' }] } }] } });
  const r = await complete({ prompt: 'q' });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.answer, 'Pinned.');
});

for (const k of ENV_KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}
globalThis.fetch = realFetch;

console.log(results.join('\n'));
console.log(process.exitCode ? '\nSOME TESTS FAILED' : `\nALL ${results.length} TESTS PASSED`);

