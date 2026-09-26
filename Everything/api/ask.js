import { requireUser } from './lib/auth.js';

// Ask/search model provider adapter.
//
// One env var picks the provider, so switching vendors needs no code deployment. It lives inline in
// this route because api/ is already at Vercel Hobby's 12-function limit.
//
//   AI_PROVIDER=groq | gemini | openai | openrouter | anthropic   (auto-detected if unset)
//   GROQ_API_KEY       + GROQ_MODEL         (default: openai/gpt-oss-120b)
//   GEMINI_API_KEY     + GEMINI_MODEL       (default: gemini-flash-latest)
//   OPENAI_API_KEY     + OPENAI_MODEL       (+ OPENAI_BASE_URL for any OpenAI-compatible API)
//   OPENROUTER_API_KEY + OPENROUTER_MODEL   (default: openrouter/free)
//   ANTHROPIC_API_KEY  + ANTHROPIC_MODEL

const PROVIDERS = {
  // Gemini first: larger free token allowance than Groq, and smart capture uses the same model.
  // Not assumed healthy — a free key returns 429 when spent, and the adapter skips a provider that
  // just failed rather than paying the failed attempt every request.
  gemini: { keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL', defaultModel: 'gemini-flash-latest' },
  // Groq is the fallback; its free gpt-oss-120b allows only 8K input tokens/minute, so request
  // volume and context size are bounded rather than assumed. (llama-3.3-70b is Enterprise-only.)
  groq: { keyVar: 'GROQ_API_KEY', modelVar: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-120b' },
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

// How long a provider is skipped after a failure. Long enough that a user does not pay the failure
// again on their next few queries, short enough that a fixed key recovers on its own.
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

// Per-instance memory of which providers just failed. A module-scope Map survives between requests
// in a warm function instance, which is what makes the skip stick; a cold start simply starts empty
// and tries the normal order. Best effort by design — correctness never depends on this.
const failureMemory = new Map();

function noteFailure(provider) {
  failureMemory.set(provider, Date.now() + FAILURE_COOLDOWN_MS);
}

function clearFailure(provider) {
  failureMemory.delete(provider);
}

function isCoolingDown(provider) {
  const until = failureMemory.get(provider);
  if (!until) return false;
  if (Date.now() >= until) {
    failureMemory.delete(provider);
    return false;
  }
  return true;
}

// Clears the remembered failures. Production never calls this — the point is that a warm instance
// keeps the memory. It exists so a test run starts from a clean slate instead of inheriting another
// test's failures, which is the same isolation the provider tests had before this feature existed.
export function resetFailureMemory() {
  failureMemory.clear();
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

/* Reasoning models (the GPT-OSS family on Groq) emit a `reasoning` field before `content`, and
   with a tight token budget every token can land in `reasoning`, leaving `content` empty. Reading
   only `content` therefore reported a successful 200 as a failure ("groq:empty"). Fall back
   through the other places a response can carry text before giving up. */
function extractText(provider, data) {
  if (provider === 'gemini') {
    return (data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join('').trim();
  }
  if (provider === 'anthropic') {
    return (data?.content || []).map((block) => block?.text || '').join('').trim();
  }
  const choice = data?.choices?.[0];
  const candidates = [
    choice?.message?.content,
    choice?.message?.reasoning,
    choice?.text,
    choice?.delta?.content,
  ];
  for (const value of candidates) {
    // Some providers send null or a block array rather than a string.
    const text = typeof value === 'string' ? value : '';
    if (text.trim()) return text.trim();
  }
  return '';
}

/* Describes the *shape* of a response — key names, counts and finish reason only. Never values,
   never anything derived from the API key. This is what makes an empty 200 diagnosable from
   outside the function, where the server logs are not visible. */
function describeShape(data) {
  if (!data || typeof data !== 'object') return { type: typeof data };
  const out = { top: Object.keys(data).slice(0, 12) };
  if (Array.isArray(data.choices)) {
    out.choices = data.choices.length;
    const choice = data.choices[0];
    if (choice && typeof choice === 'object') {
      out.choiceKeys = Object.keys(choice).slice(0, 12);
      if (choice.finish_reason) out.finishReason = choice.finish_reason;
      const message = choice.message || choice.delta;
      if (message && typeof message === 'object') {
        out.messageKeys = Object.keys(message).slice(0, 12);
        for (const key of ['content', 'reasoning', 'refusal']) {
          if (key in message) {
            const v = message[key];
            out[key] = typeof v === 'string' ? `string(${v.length})` : typeof v;
          }
        }
      }
    }
  } else if (Array.isArray(data.candidates)) {
    out.candidates = data.candidates.length;
  }
  if (typeof data.error === 'object' && data.error) out.errorKeys = Object.keys(data.error).slice(0, 8);
  return out;
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
  // Reasoning models (GPT-OSS) spend the token budget on hidden reasoning before answering, so a
  // short budget can be exhausted before `content` appears. Ask for the lightest reasoning
  // setting to keep a grounded answer affordable.
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low';

  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
    // A 200 with no usable text is the one failure that is hardest to diagnose from the outside,
    // so the shape is reported (key names and finish reason only, never values or secrets).
    const shape = describeShape(data);
    console.error(`ask: ${provider}/${model} returned an empty body:`, JSON.stringify(shape));
    return {
      status: 502,
      error: 'The model returned an empty answer.',
      retryable: true,
      reason: `${provider}:empty`,
      shape,
    };
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
//
// `trace` makes a successful-but-degraded result say so. Without it, a dead primary hides behind a
// working fallback and the health probe reports ok: true.
export async function complete({ prompt, maxTokens = 300, trace = false }) {
  const chain = providerChain();
  if (!chain.length) {
    const resolved = resolveProvider();
    return resolved?.missingKey
      ? { status: 503, error: `AI search is not configured: ${PROVIDERS[resolved.provider].keyVar} is not set.`, reason: 'not-configured' }
      : { status: 503, error: 'AI search is not configured. Add a model provider API key.', reason: 'not-configured' };
  }

  // A provider that just failed is skipped for a few minutes so it cannot burn the whole per-attempt
  // budget on every single query. This is per warm instance and best effort — a cold start simply
  // has no memory and retries the normal order, which is correct, just slower.
  const usable = chain.filter((entry) => !isCoolingDown(entry.provider));
  // Never skip everything: if every provider is cooling down, the fastest route to a real answer is
  // to try them again rather than give up.
  const candidates = usable.length ? usable : chain;

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const tried = [];
  const shapes = [];
  let last = { status: 502, error: 'AI search is temporarily unavailable.', reason: 'unknown' };
  for (const entry of candidates) {
    const result = await attempt(entry, { prompt, maxTokens, deadline });
    if (result.answer) {
      clearFailure(entry.provider);
      const skipNote = usable.length ? [] : ['all-providers-retried-after-failure'];
      return trace
        ? {
            ...result,
            // `attempted` makes a silent fallback visible: non-empty means the primary did not
            // answer, even though the overall result looks like a success.
            attempted: [...skipNote, ...tried],
            degraded: tried.length > 0 || skipNote.length > 0,
          }
        : result;
    }
    noteFailure(entry.provider);
    tried.push(result.reason || `${entry.provider}:error`);
    if (result.shape) shapes.push({ provider: entry.provider, model: entry.model, ...result.shape });
    last = result;
    if (!result.retryable) break;
    console.warn(`ask: falling back from ${entry.provider} to the next configured provider`);
  }
  // Report the whole trail so "everything failed" is distinguishable from "one bad key".
  return { ...last, reason: tried.join(' -> '), shapes };
}

/* Sends a real, minimal completion to prove the configured provider actually works.
   `aiStatus()` only proves a key exists; a key can be present and still be rejected, which is
   how a broken provider went unnoticed. This is opt-in via /api/health?probe=1 so ordinary
   health polling never spends quota, and the answer is a fixed "ping" rather than user data. */
export async function probeProvider() {
  const started = Date.now();
  // `trace` is what makes a silently-broken primary visible. Without it the probe reports the
  // fallback that succeeded and reports `ok: true`, hiding the fact that the primary failed.
  const result = await complete({
    prompt: 'Reply with the single word: ok',
    // A reasoning model needs headroom before it produces any visible text; a tiny budget
    // returns 200 with an empty body and would look like a failure.
    maxTokens: 64,
    trace: true,
  });
  return {
    ok: Boolean(result.answer),
    provider: result.provider || null,
    model: result.model || null,
    reason: result.reason || null,
    status: result.status || null,
    sample: result.answer ? String(result.answer).slice(0, 40) : null,
    durationMs: Date.now() - started,
    // `configuredProvider` is who was *intended* to answer, so a fallback answering is visible even
    // without a failure. `attempted` lists the failures that led to the fallback.
    configuredProvider: aiStatus().provider || null,
    degraded: Boolean(result.degraded),
    ...(result.attempted ? { attempted: result.attempted } : {}),
    // Present on failure: the shape of the upstream response, so an empty 200 is diagnosable
    // without access to the function's logs. Key names and lengths only, never values.
    ...(result.shapes ? { shapes: result.shapes } : {}),
  };
}

// Free tiers cap input tokens per minute, so the context is bounded. 10 fits the budget; the client
// already sends only the top ranked matches (ASK_CONTEXT_MATCHES = 12).
const MAX_CONTEXT_ITEMS = 10;
const MAX_FIELD = 120;

/* One context line per item. The client now sends a normalised payload (askContextPayload), so
   status/project/recurrence/checklist are present and must be rendered here — without them the
   model could not answer questions about workflow state, because only title/sub/person/priority
   used to reach it. Completed items are marked so the model does not offer them as open work. */
export function buildContextLine(item) {
  const bits = [item.kind, item.status, item.priority].filter(Boolean);
  const label = `[${bits.join('/') || 'item'}]`;
  const title = String(item.title || '').slice(0, MAX_FIELD);
  const sub = item.sub ? `: ${String(item.sub).slice(0, MAX_FIELD)}` : '';
  const meta = [
    item.project ? `project: ${item.project}` : '',
    item.person ? `person: ${item.person}` : '',
    item.due ? `due: ${item.due}` : '',
    item.recurrence ? `repeats: ${item.recurrence}` : '',
    item.checklist ? `checklist: ${item.checklist}` : '',
    item.done ? 'completed' : '',
  ].filter(Boolean);
  return `- ${label} ${title}${sub}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

/* ---------- Structured capture extraction ----------
   Smart capture used to be regex-only in the browser, so one sentence carrying several
   things ("ring the shop about the quote tomorrow, and remind me to pay the invoice")
   was classified by pattern matching alone and the second half was lost.

   This asks the same configured model for a structured read. It lives inside this route
   rather than as a second function because the project is already at Vercel Hobby's
   12-function limit. The browser still applies its own local rules first and only calls
   this when those rules are unsure, so ordinary captures stay instant and cost nothing. */
const EXTRACTION_KINDS = ['task', 'event', 'memory', 'waiting', 'openloop'];
const EXTRACTION_RECURRENCE = ['none', 'daily', 'weekly', 'monthly'];
const EXTRACTION_PRIORITY = ['high', 'medium', 'low'];
const EXTRACTION_CONFIDENCE = ['high', 'medium', 'low'];

const oneOf = (value, allowed, fallback) => {
  const raw = String(value ?? '').trim().toLowerCase();
  return allowed.includes(raw) ? raw : fallback;
};

export function buildExtractionPrompt(text, today) {
  return `You turn one captured sentence into structured data for a personal productivity app called Everything. Today is ${today}.

Rules:
- One sentence often carries more than one thing (a task plus a promise, a date plus a follow-up). Put the thing the person must act on in the title.
- Never invent a date. If the wording is vague ("maybe Friday", "sometime next week"), leave dueDate empty and put the question in ambiguous.
- "waiting for X" is a waiting item, not a task.
- An undecided question ("need to decide which laptop") is an openloop.
- A fact or preference about a person is a memory.
- A fixed time with someone ("call Ravi at 10") is an event.

Respond with ONLY raw JSON, no prose and no code fence:
{"kind":"task|event|memory|waiting|openloop","title":"short imperative title","dueDate":"ISO 8601 datetime or empty string","person":"name or empty string","project":"name or empty string","priority":"high|medium|low or empty string","recurrence":"none|daily|weekly|monthly","confidence":"high|medium|low","ambiguous":"one short question if something is genuinely unclear, otherwise empty string"}

Sentence: ${text}`;
}

/* Tolerant reader for a model reply: strips code fences and any prose around the object, then
   validates every field against the allowed values. Validation matters because the result is
   written straight into the capture form — a hallucinated kind or date must not be able to
   put the sheet into a state the UI cannot represent. */
export function parseExtraction(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    kind: oneOf(parsed.kind, EXTRACTION_KINDS, ''),
    title: str(parsed.title).slice(0, 200),
    dueDate: str(parsed.dueDate).slice(0, 40),
    person: str(parsed.person).slice(0, 80),
    project: str(parsed.project).slice(0, 80),
    priority: oneOf(parsed.priority, EXTRACTION_PRIORITY, ''),
    recurrence: oneOf(parsed.recurrence, EXTRACTION_RECURRENCE, 'none'),
    confidence: oneOf(parsed.confidence, EXTRACTION_CONFIDENCE, 'medium'),
    ambiguous: str(parsed.ambiguous).slice(0, 200),
  };
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  const { query, items, today } = body;
  // The browser knows the user's real local date; the server clock may be UTC. Preferring the
  // client value is what lets "today" and "this week" be answered correctly.
  const currentDate = String(today || '').slice(0, 60) || new Date().toDateString();

  // Smart capture. A failure here is never fatal to the capture sheet: the browser keeps the
  // local rule-based result and simply saves without the model's refinement.
  if (body.action === 'extract') {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Missing text' });

    const result = await complete({
      prompt: buildExtractionPrompt(text, currentDate),
      // A reasoning model needs headroom before it emits visible text; too small a budget
      // returns 200 with an empty body, which is what made this look like a failure.
      maxTokens: 400,
    });
    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error, reason: result.reason });
    }
    const extraction = parseExtraction(result.answer);
    if (!extraction) {
      return res.status(502).json({
        error: 'The model did not return a usable result.',
        reason: `${result.provider}:unparsable`,
      });
    }
    return res.status(200).json({ extraction, provider: result.provider, model: result.model });
  }

  if (!query || !query.trim()) return res.status(400).json({ error: 'Missing query' });

  const context = (items || [])
    .filter((item) => item && !item.archivedAt && !item.archived_at)
    .slice(0, MAX_CONTEXT_ITEMS)
    .map(buildContextLine)
    .join('\n');

  const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Today is ${currentDate}. Be concise (2-4 sentences), specific, and reference relevant items by name. Use the status and due fields to judge what is current, overdue or still open. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context || '(none)'}\n\nQuestion: ${query}`;

  const result = await complete({ prompt, maxTokens: 600 });
  if (result.error) {
    // `reason` is a short provider/status trail (e.g. "groq:429 -> gemini:timeout").
    return res.status(result.status || 500).json({ error: result.error, reason: result.reason });
  }
  return res.status(200).json({ answer: result.answer, provider: result.provider, model: result.model });
}
