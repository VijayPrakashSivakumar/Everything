import { requireUser } from './lib/auth.js';

// Ask/search model provider adapter.
//
// The browser UI, the `/api/ask` response contract, and the offline keyword fallback are
// all unchanged — only the upstream model is configurable. One env var picks the provider,
// so switching models or vendors never requires another code deployment. It lives inline in
// this route on purpose: api/ is already at Vercel Hobby's 12-function limit.
//
//   AI_PROVIDER=groq | gemini | openai | openrouter | anthropic   (auto-detected if unset)
//   GROQ_API_KEY       + GROQ_MODEL         (default: openai/gpt-oss-120b)
//   GEMINI_API_KEY     + GEMINI_MODEL       (default: gemini-flash-latest)
//   OPENAI_API_KEY     + OPENAI_MODEL       (+ OPENAI_BASE_URL for any OpenAI-compatible API)
//   OPENROUTER_API_KEY + OPENROUTER_MODEL   (default: openrouter/free)
//   ANTHROPIC_API_KEY  + ANTHROPIC_MODEL

const PROVIDERS = {
  // Groq is listed first because its free tier is the fastest for this workload.
  // NOTE: llama-3.3-70b-versatile is an Enterprise model on Groq, so the free default is a
  // GPT-OSS model, which is what the free plan actually serves.
  groq: { keyVar: 'GROQ_API_KEY', modelVar: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b' },
  gemini: { keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL', defaultModel: 'gemini-flash-latest' },
  openai: { keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL', defaultModel: 'gpt-4o-mini' },
  openrouter: { keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL', defaultModel: 'openrouter/free' },
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-4-6' },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// Statuses worth retrying on a different provider: rate limits (429), exhausted quota (402),
// and upstream/server errors. 400/401/403 are NOT retried — a malformed request or a bad key
// will fail identically everywhere, so retrying just wastes the user's time.
const FALLBACK_STATUSES = new Set([402, 429, 500, 502, 503, 504]);

// The serverless function has a hard platform duration limit (10s on the Hobby plan). If the
// budget is exceeded the platform kills the function and returns a NON-JSON error page, which
// the client can only report as a generic failure. So provider work is bounded by a total
// budget, not just a per-attempt one: two sequential 8s attempts would overrun the limit.
const TOTAL_BUDGET_MS = 8000;
// The first provider gets the larger slice; a fallback only gets whatever is left. A fallback
// is worth having, but a real answer is worth more than a second attempt.
const PER_ATTEMPT_MS = 6000;

// An explicit AI_PROVIDER pins the *primary* only. It still falls back to the other
// configured providers, because being rate limited is no reason to break Ask.
function providerOrder() {
  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (!PROVIDER_NAMES.includes(requested)) return PROVIDER_NAMES;
  return [requested, ...PROVIDER_NAMES.filter((name) => name !== requested)];
}

// Races a request against a deadline. The controller is passed into the fetch itself, so a
// timed-out provider also has its socket closed rather than lingering in the background.
function withTimeout(request, ms, controller) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
}

// The provider list to try, in order: only ones that actually have a key, so a fallback
// never burns a request on an unconfigured provider.
function providerChain() {
  return providerOrder()
    .filter((name) => process.env[PROVIDERS[name].keyVar])
    .map((name) => ({
      provider: name,
      model: process.env[PROVIDERS[name].modelVar] || PROVIDERS[name].defaultModel,
      key: process.env[PROVIDERS[name].keyVar],
    }));
}

// An explicit AI_PROVIDER always wins, so a key left over from a previous setup can never
// silently take over. Without it, the first configured provider is used.
function resolveProvider() {
  const [first] = providerChain();
  if (first) return { provider: first.provider, model: first.model };

  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (PROVIDER_NAMES.includes(requested)) {
    return { provider: requested, model: PROVIDERS[requested].defaultModel, missingKey: true };
  }
  return null;
}

export function aiStatus() {
  const chain = providerChain();
  const resolved = resolveProvider();
  if (!resolved) return { configured: false, provider: 'none', model: null, fallbacks: [] };
  return {
    configured: !resolved.missingKey,
    provider: resolved.provider,
    model: resolved.model,
    // Every other configured provider that can take over when the primary is rate limited.
    fallbacks: chain.slice(1).map((entry) => `${entry.provider}/${entry.model}`),
    missingKeyVar: resolved.missingKey ? PROVIDERS[resolved.provider].keyVar : null,
  };
}

function extractText(provider, data) {
  if (provider === 'gemini') {
    return (data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join('').trim();
  }
  if (provider === 'anthropic') {
    return (data?.content || []).map((block) => block?.text || '').join('').trim();
  }
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

function callGemini({ key, model, prompt, maxTokens, signal }) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      }),
      signal,
    },
  );
}

function callAnthropic({ key, model, prompt, maxTokens, signal }) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
}

function callOpenAiCompatible({ provider, key, model, prompt, maxTokens, signal }) {
  const knownBases = {
    groq: 'https://api.groq.com/openai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
  };
  // OPENAI_BASE_URL still overrides everything, so any OpenAI-compatible host can be used.
  const base = String(process.env.OPENAI_BASE_URL || knownBases[provider] || knownBases.openai).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://everything-app-zeta.vercel.app';
    headers['X-Title'] = 'Everything';
  }
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
}

// One attempt against a single provider. Returns { answer } or { error, retryable, status, reason }.
// `reason` is a short, key-free diagnostic (e.g. "groq:429") so a failure can be identified
// from the UI without exposing anything sensitive.
async function attempt(entry, { prompt, maxTokens, deadline }) {
  const { provider, model, key } = entry;
  // Every attempt shares the one total budget, so the function always answers in time.
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { status: 502, error: 'AI search is temporarily unavailable.', retryable: false, reason: `${provider}:budget` };
  }
  const budgetMs = Math.min(PER_ATTEMPT_MS, remaining);
  const controller = new AbortController();
  try {
    const request =
      provider === 'gemini'
        ? callGemini({ key, model, prompt, maxTokens, signal: controller.signal })
        : provider === 'anthropic'
          ? callAnthropic({ key, model, prompt, maxTokens, signal: controller.signal })
          : callOpenAiCompatible({ provider, key, model, prompt, maxTokens, signal: controller.signal });

    const response = await withTimeout(request, budgetMs, controller);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || `HTTP ${response.status}`;
      console.error(`ask: ${provider}/${model} failed:`, detail);
      return {
        status: 502,
        error: 'AI search is temporarily unavailable.',
        retryable: FALLBACK_STATUSES.has(response.status),
        reason: `${provider}:${response.status}`,
      };
    }

    const answer = extractText(provider, data);
    if (answer) return { answer, provider, model };
    console.error(`ask: ${provider}/${model} returned an empty body:`, JSON.stringify(data).slice(0, 300));
    return { status: 502, error: 'The model returned an empty answer.', retryable: true, reason: `${provider}:empty` };
  } catch (err) {
    // Timeouts and transport failures are always worth retrying elsewhere.
    console.error(`ask: ${provider}/${model} request failed:`, err?.message || err);
    const timedOut = controller.signal.aborted || /timeout|abort/i.test(err?.message || '');
    return {
      status: 502,
      error: 'AI search is temporarily unavailable.',
      retryable: true,
      reason: `${provider}:${timedOut ? 'timeout' : 'network'}`,
    };
  }
}

// Walks the configured providers in order and returns the first usable answer.
// Never throws, so the route handler stays trivial.
export async function complete({ prompt, maxTokens = 300 }) {
  const chain = providerChain();
  if (!chain.length) {
    const resolved = resolveProvider();
    return resolved?.missingKey
      ? { status: 503, error: `AI search is not configured: ${PROVIDERS[resolved.provider].keyVar} is not set.`, reason: 'not-configured' }
      : { status: 503, error: 'AI search is not configured. Add a model provider API key.', reason: 'not-configured' };
  }

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const tried = [];
  let last = { status: 502, error: 'AI search is temporarily unavailable.', reason: 'unknown' };
  for (const entry of chain) {
    const result = await attempt(entry, { prompt, maxTokens, deadline });
    if (result.answer) return result;
    tried.push(result.reason || `${entry.provider}:error`);
    last = result;
    if (!result.retryable) break;
    console.warn(`ask: falling back from ${entry.provider} to the next configured provider`);
  }
  // Report the whole trail so "everything failed" is distinguishable from "one bad key".
  return { ...last, reason: tried.join(' -> ') };
}

// Free tiers (Groq in particular) cap input tokens per minute, so the context is bounded
// rather than sending every item. Newest items are the useful ones, and each line is
// truncated so one very long title cannot consume the whole budget.
const MAX_CONTEXT_ITEMS = 30;
const MAX_FIELD = 120;

export function buildContextLine(item) {
  const label = `[${item.kind || 'item'}${item.priority ? '/' + item.priority : ''}]`;
  const title = String(item.title || '').slice(0, MAX_FIELD);
  const sub = item.sub ? `: ${String(item.sub).slice(0, MAX_FIELD)}` : '';
  const person = item.person ? ` (person: ${item.person})` : '';
  const due = item.due ? ` (due: ${item.due})` : '';
  return `- ${label} ${title}${sub}${person}${due}`;
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { query, items } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing query' });

  const context = (items || [])
    .filter((item) => item && !item.archivedAt && !item.archived_at)
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(buildContextLine)
    .join('\n');

  const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences), specific, and reference relevant items by name. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context}\n\nQuestion: ${query}`;

  const result = await complete({ prompt });
  if (result.error) {
    // `reason` is a short provider/status trail (e.g. "groq:429 -> gemini:timeout").
    return res.status(result.status || 500).json({ error: result.error, reason: result.reason });
  }
  return res.status(200).json({ answer: result.answer, provider: result.provider, model: result.model });
}
