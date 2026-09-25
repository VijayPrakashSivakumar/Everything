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

// Mock transport: records the call and returns whatever the scenario dictates.
globalThis.fetch = async (url) => {
  seen.push(String(url));
  const r = handler(String(url), seen.length);
  const status = r.status || 200;
  return { ok: status >= 200 && status < 300, status, json: async () => r.body || {} };
};

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

const { complete, aiStatus } = await import('../api/ask.js');

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
  // Restore the normal mock so later scenarios are not left with the hanging transport.
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const res = handler(String(url), seen.length);
    const status = res.status || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => res.body || {} };
  };
});

await check('aiStatus reports the primary and the configured fallbacks', async () => {
  setEnv({ GROQ_API_KEY: 'k', GEMINI_API_KEY: 'g' });
  const s = aiStatus();
  assert.equal(s.configured, true);
  assert.equal(s.provider, 'groq');
  assert.equal(s.model, 'openai/gpt-oss-120b');
  assert.deepEqual(s.fallbacks, ['gemini/gemini-flash-latest']);
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

