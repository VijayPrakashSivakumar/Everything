import { requireUser } from './lib/auth.js';

// Ask/search model provider adapter.
//
// The browser UI, the `/api/ask` response contract, and the offline keyword fallback are
// all unchanged — only the upstream model is configurable. One env var picks the provider,
// so switching models or vendors never requires another code deployment. It lives inline in
// this route on purpose: api/ is already at Vercel Hobby's 12-function limit.
//
//   AI_PROVIDER=gemini | openai | openrouter | anthropic   (auto-detected if unset)
//   GEMINI_API_KEY     + GEMINI_MODEL      (default: gemini-flash-latest)
//   OPENAI_API_KEY     + OPENAI_MODEL      (+ OPENAI_BASE_URL for any OpenAI-compatible API)
//   OPENROUTER_API_KEY + OPENROUTER_MODEL  (default: openrouter/free)
//   ANTHROPIC_API_KEY  + ANTHROPIC_MODEL

const PROVIDERS = {
  gemini: { keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL', defaultModel: 'gemini-flash-latest' },
  openai: { keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL', defaultModel: 'gpt-4o-mini' },
  openrouter: { keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL', defaultModel: 'openrouter/free' },
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-4-6' },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

// An explicit AI_PROVIDER always wins, so a key left over from a previous setup can never
// silently take over. Without it, the first configured provider is used.
function resolveProvider() {
  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const explicit = PROVIDER_NAMES.includes(requested);
  const ordered = explicit ? [requested] : PROVIDER_NAMES;

  for (const name of ordered) {
    if (process.env[PROVIDERS[name].keyVar]) {
      return { provider: name, model: process.env[PROVIDERS[name].modelVar] || PROVIDERS[name].defaultModel };
    }
  }
  if (explicit) return { provider: requested, model: PROVIDERS[requested].defaultModel, missingKey: true };
  return null;
}

export function aiStatus() {
  const resolved = resolveProvider();
  if (!resolved) return { configured: false, provider: 'none', model: null };
  return {
    configured: !resolved.missingKey,
    provider: resolved.provider,
    model: resolved.model,
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

function callGemini({ key, model, prompt, maxTokens }) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      }),
    },
  );
}

function callAnthropic({ key, model, prompt, maxTokens }) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
}

function callOpenAiCompatible({ provider, key, model, prompt, maxTokens }) {
  const base =
    provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
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
  });
}

// Returns { answer } or { error, status }. Never throws, so the route handler stays trivial.
// Exported so the provider adapter can be unit-tested without an authenticated request.
export async function complete({ prompt, maxTokens = 300 }) {
  const resolved = resolveProvider();
  if (!resolved) return { status: 503, error: 'AI search is not configured. Add a model provider API key.' };
  if (resolved.missingKey) {
    return { status: 503, error: `AI search is not configured: ${PROVIDERS[resolved.provider].keyVar} is not set.` };
  }

  const { provider, model } = resolved;
  const key = process.env[PROVIDERS[provider].keyVar];
  try {
    const response =
      provider === 'gemini'
        ? await callGemini({ key, model, prompt, maxTokens })
        : provider === 'anthropic'
          ? await callAnthropic({ key, model, prompt, maxTokens })
          : await callOpenAiCompatible({ provider, key, model, prompt, maxTokens });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`ask: ${provider}/${model} failed:`, data?.error?.message || data?.message || `HTTP ${response.status}`);
      return { status: 502, error: 'AI search is temporarily unavailable.' };
    }
    const answer = extractText(provider, data);
    return answer ? { answer } : { status: 502, error: 'The model returned an empty answer.' };
  } catch (err) {
    console.error(`ask: ${provider}/${model} request failed:`, err?.message || err);
    return { status: 500, error: 'AI request failed' };
  }
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { query, items } = req.body || {};
  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing query' });

  const context = (items || []).filter((item) => !item.archivedAt && !item.archived_at).slice(0, 60)
    .map(i => `- [${i.kind}${i.priority ? '/' + i.priority : ''}] ${i.title}${i.sub ? ': ' + i.sub : ''}${i.person ? ' (person: ' + i.person + ')' : ''}${i.due ? ' (due: ' + i.due + ')' : ''}`)
    .join('\n');

  const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences), specific, and reference relevant items by name. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context}\n\nQuestion: ${query}`;

  const result = await complete({ prompt });
  if (result.error) return res.status(result.status || 500).json({ error: result.error });
  return res.status(200).json({ answer: result.answer });
}
