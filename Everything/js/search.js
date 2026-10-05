/* ---------- Ask / Search ---------- */
/* Two entry points share one search engine:
     - the header input, which streams results into a dropdown (what tapping search does now)
     - the full-screen overlay, still reachable via Ctrl+K / "/" for keyboard users
   Both render from the same helpers so results and the AI answer never drift apart. */

/* Words that carry no retrieval signal. Without this filter a question like "what should I do
   today" is searched as one long phrase that appears in no title, so the search silently
   returns nothing. Dropping them leaves the meaningful terms. */
const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do",
  "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "should", "show", "some", "tell", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

/* Splits a query into meaningful lowercase terms. Falls back to the whole trimmed string when
   the query is nothing but stop words ("the?", "what?"), so a match is still possible. */
function searchTerms(q) {
  const words = String(q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((word) => word.length > 1 && !SEARCH_STOP_WORDS.has(word));
  return meaningful.length ? meaningful : words;
}

/* Every field worth searching, in descending order of importance. The old haystack was only
   title + sub + person, so a query like "urgent Atlas project" matched nothing even when the
   item was a high-priority task on that project. */
function searchHaystack(item) {
  const status = item?.kind === "task" ? taskStatusFromItem(item) : item?.status || "";
  const steps = normaliseChecklist(item?.checklist).map((step) => step.text).join(" ");
  return [
    item?.title,
    item?.sub,
    item?.person,
    item?.project,
    taskStatusLabel(status),
    item?.priority,
    item?.kind,
    item?.recurrence && item.recurrence !== "none" ? item.recurrence : "",
    steps,
    item?.rawText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/* Natural words a person actually types, mapped to the values this app stores. Without this,
   "urgent" finds nothing because priority is saved as "high", and "blocked" finds nothing
   because the status is "waiting". A term matches itself or any of its aliases. */
const SEARCH_ALIASES = {
  urgent: ["high", "asap", "important", "critical"],
  important: ["high", "urgent"],
  critical: ["high", "urgent"],
  high: ["urgent", "important", "critical"],
  blocked: ["waiting"],
  waiting: ["blocked"],
  todo: ["planned"],
  doing: ["in_progress", "progress"],
  progress: ["in_progress", "doing"],
  done: ["completed"],
  completed: ["done"],
  note: ["memory"],
  memo: ["memory"],
  meeting: ["event"],
  call: ["phone"],
  phone: ["call"],
};

function searchAliases(term) {
  return SEARCH_ALIASES[term] || [];
}

/* Scores one item against the query terms. Every term must appear somewhere (AND), which keeps
   precision high; a whole-phrase hit and a title hit are worth extra so the obvious match sorts
   first. Returns 0 for no match, which is what the filter below relies on. */
function searchScore(item, terms, phrase) {
  const haystack = searchHaystack(item);
  if (!haystack) return 0;
  const title = String(item?.title || "").toLowerCase();

  let score = 0;
  for (const term of terms) {
    const hit = haystack.includes(term);
    const alias = !hit && searchAliases(term).some((alt) => haystack.includes(alt));
    if (!hit && !alias) return 0;
    score += 1;
    if (title.includes(term)) score += 3;
  }
  // The full phrase appearing intact is the strongest possible signal.
  if (phrase && haystack.includes(phrase)) score += 4;
  // A due date makes time-based questions ("what's due today") answerable from the ranking.
  if (item?.dueDate || item?.due_date) score += 1;
  return score;
}

/* ---------- Fuzzy fallback ----------
   The exact matcher is substring-only, so "grocery" finds nothing against "Groceries run", and a
   typo finds nothing at all. Consulted only when the exact pass came up empty, so results that
   already work keep their exact order. */

/* Below this length, words are too close together to match safely: "car" is one edit from
   "cat", "bar" and "can", so fuzzy matching at that size is mostly noise. */
const SEARCH_FUZZY_MIN_LENGTH = 4;
const SEARCH_FUZZY_MAX_DISTANCE = 2;
/* Stops a pathological query from scanning a huge archive on every keystroke. */
const SEARCH_FUZZY_SCAN_LIMIT = 400;
/* More than this many words is not a real search, it is a sentence, and fuzzy gets too vague. */
const SEARCH_FUZZY_MAX_TERMS = 6;

/* Folds the endings English actually adds, so "notes"/"note" are one word. Cautious by design: a
   stem is only produced while it stays long enough to still mean something. */
function searchNormaliseWord(word) {
  const w = String(word || "");
  if (w.length < 4) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  if (/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
  if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
  return w;
}

/* Edit distance, bounded. Returns max + 1 as soon as the words are further apart than max, so
   the overwhelmingly common "not remotely similar" pair costs a couple of comparisons instead
   of filling the whole row. */
function searchEditDistance(a, b, max) {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > max) return max + 1;
  const row = new Array(lenB + 1);
  let prev = new Array(lenB + 1);
  let curr = row;
  for (let j = 0; j <= lenB; j++) prev[j] = j;
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let best = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[lenB];
}

/* The searchable words of one item, cached against its haystack. Re-splitting on every keystroke is
   the expensive part, not the comparison. Bounded, and cleared wholesale. */
const searchWordCache = new Map();
const SEARCH_WORD_CACHE_LIMIT = 400;
function searchWords(item) {
  const haystack = searchHaystack(item);
  if (!haystack) return [];
  const cached = searchWordCache.get(haystack);
  if (cached) return cached;
  const words = haystack.split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  if (searchWordCache.size >= SEARCH_WORD_CACHE_LIMIT) searchWordCache.clear();
  searchWordCache.set(haystack, words);
  return words;
}

/* One query term against one item's words. A stem match is a real difference in spelling form and
   scores well above an edit-distance guess, which is the user being nearly right. */
function searchTermScore(term, words) {
  const needle = searchNormaliseWord(term);
  let best = 0;
  for (const word of words) {
    if (word === term) return 4;
    if (searchNormaliseWord(word) === needle) return 3;
    if (needle.length < SEARCH_FUZZY_MIN_LENGTH) continue;
    // A shorter word gets a tighter budget: at six letters an extra edit is usually still a
    // real word, at four it usually is not.
    const max = needle.length >= 6 ? SEARCH_FUZZY_MAX_DISTANCE : 1;
    if (Math.abs(word.length - needle.length) > max) continue;
    if (searchEditDistance(word, needle, max) <= max) best = Math.max(best, 1);
  }
  return best;
}

/* AND across terms, exactly as the exact matcher does, so adding a word still narrows the
   results rather than widening them. */
function searchFuzzyScore(item, terms) {
  const words = searchWords(item);
  if (!words.length) return 0;
  let score = 0;
  for (const term of terms) {
    const termScore = searchTermScore(term, words);
    if (!termScore) return 0;
    score += termScore;
  }
  if (item?.dueDate || item?.due_date) score += 1;
  return score;
}

/* The one search engine behind both the header dropdown and the Ask overlay. Returns the
   best-matching items, most relevant first, so the AI is given the items that actually answer
   the question instead of the first N in insertion order. */
function searchMatches(q) {
  const phrase = String(q || "").toLowerCase().trim();
  if (!phrase) return [];
  const terms = searchTerms(phrase);
  const live = state.items.filter((item) => !isArchived(item));

  const exact = live
    .map((item) => ({ item, score: searchScore(item, terms, phrase) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.created || 0) - (a.item.created || 0))
    .map((entry) => entry.item);

  if (exact.length) return exact;
  if (terms.length > SEARCH_FUZZY_MAX_TERMS) return exact;

  return live
    .slice(0, SEARCH_FUZZY_SCAN_LIMIT)
    .map((item) => ({ item, score: searchFuzzyScore(item, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.created || 0) - (a.item.created || 0))
    .map((entry) => entry.item);
}

/* Builds the context sent to the model. The ranked matches lead, because those are what answer
   the question. A broad question ("what should I do now") may only match one item, so recent
   open work is then appended up to a floor: the model needs enough to actually answer, and an
   earlier version sent an arbitrary slice of the list instead. Bounded for the token cap. */
const ASK_CONTEXT_MATCHES = 12;
const ASK_CONTEXT_MINIMUM = 8;
function askContextPool(q) {
  const ranked = searchMatches(q).slice(0, ASK_CONTEXT_MATCHES);
  if (ranked.length >= ASK_CONTEXT_MINIMUM) return ranked;

  const chosen = new Set(ranked.map((item) => item.id));
  const recent = [...state.items]
    .filter((item) => !isArchived(item) && !chosen.has(item.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  const filler = recent.slice(0, ASK_CONTEXT_MINIMUM - ranked.length);
  return [...ranked, ...filler];
}

let searchDropDebounce = null;
let searchDropQuery = "";

function openSearch() {
  const dd = document.getElementById("searchDropdown");
  if (!dd) return;
  dd.hidden = false;
  document.getElementById("searchInput")?.setAttribute("aria-expanded", "true");
  if (!dd.dataset.touched) {
    dd.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  }
}

function closeSearch() {
  const dd = document.getElementById("searchDropdown");
  const input = document.getElementById("searchInput");
  if (!dd) return;
  dd.hidden = true;
  delete dd.dataset.touched;
  input?.setAttribute("aria-expanded", "false");
}

/* Enter opens the full overlay pre-filled, so a typed question can be expanded and reviewed.
   Escape leaves the field, matching normal combobox behaviour. */
function searchKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    closeSearch();
    document.getElementById("searchInput").blur();
    openAsk(q);
  } else if (e.key === "Escape") {
    closeSearch();
    document.getElementById("searchInput").blur();
  }
}

function runSearch(q) {
  searchDropQuery = q;
  const dd = document.getElementById("searchDropdown");
  if (!dd) return;
  dd.dataset.touched = "1";

  if (!q.trim()) {
    dd.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
    return;
  }

  const matches = searchMatches(q);
  // The AI answer lives in its own slot so re-rendering the hit list never disturbs it. The slot
  // must be REUSED, not recreated: replacing the markup detaches the node askAI captured, and its
  // answer would be discarded, leaving the dropdown stuck on "Thinking…".
  const previousAnswer = document.getElementById("searchAskSlot")?.innerHTML || "";
  dd.innerHTML =
    (matches.length
      ? matches
          .slice(0, 8)
          .map(
            (m) =>
              `<div class="search-hit" onclick="closeSearch();document.getElementById('searchInput').value='';openPanel(${jsStr(m.id)})"><b>${escapeHtml(m.title)}</b><br><span class="search-hit-sub">${escapeHtml(m.sub || "")}</span></div>`,
          )
          .join("")
      : '<p class="empty">No matches found.</p>') +
    `<div class="search-ask" id="searchAskSlot">${previousAnswer}</div>`;

  // Ask is a debounced AI call, so it must not run on every keystroke here.
  clearTimeout(searchDropDebounce);
  searchDropDebounce = setTimeout(() => {
    if (searchDropQuery === q) {
      askAI(q, { mount: document.getElementById("searchAskSlot"), extra: "search-ask" });
    }
  }, 650);
}

function openAsk(prefill = "") {
  if (document.getElementById("sidebar")?.classList.contains("open"))
    closeSidebar();
  document.getElementById("askOverlay").classList.add("open");
  lockPageScroll(true);
  document.getElementById("askInput").value = prefill;
  document.getElementById("askResults").innerHTML =
    '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  // enterDialog puts the caret in after the class lands, and keeps Tab inside the overlay until it
  // closes — this one was missed when the other four were fixed, because the probe reads the markup
  // for overlays rather than trusting a list of the ones remembered.
  enterDialog(document.getElementById("askOverlay"), "askInput");
  if (prefill) runAsk(prefill);
}
function closeAsk() {
  const overlay = document.getElementById("askOverlay");
  overlay.classList.remove("open");
  if (!document.querySelector(".modal-overlay.open, #panel.open"))
    lockPageScroll(false);
  leaveDialog(overlay);
}
let askDebounce = null;
let lastAskQuery = "";
function runAsk(q) {
  lastAskQuery = q;
  const results = document.getElementById("askResults");
  if (!q.trim()) {
    results.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
    return;
  }
  const matches = searchMatches(q);
  let html = `<div id="aiAnswerSlot"></div>`;
  html += matches.length
    ? matches
        .map(
          (m) =>
            `<div class="ask-result-item" onclick="closeAsk();openPanel(${jsStr(m.id)})"><b>${escapeHtml(m.title)}</b><br><span style="color:var(--muted)">${escapeHtml(m.sub || "")}</span></div>`,
        )
        .join("")
    : '<p class="empty">No matches found.</p>';
  results.innerHTML = html;

  clearTimeout(askDebounce);
  askDebounce = setTimeout(() => {
    if (lastAskQuery === q) askAI(q);
  }, 550);
}

/* One context shape for both AI paths (the /api/ask route and the in-artifact `sample` path).

   The raw item objects were sent as-is, and buildContextLine() on the server only reads
   kind/priority/title/sub/person/due — so `status`, `project`, `recurrence` and checklist
   progress never reached the model, and it could not answer questions about workflow state.
   Normalising here keeps the two paths from drifting apart. */
function askContextPayload(items) {
  return items.map((item) => {
    const status = item.kind === "task" ? taskStatusFromItem(item) : item.status || "";
    const steps = checklistProgress(item);
    return {
      kind: item.kind || "item",
      title: item.title || "",
      sub: item.sub || "",
      person: item.person || "",
      project: item.project || "",
      goal: item.goal || "",
      status: taskStatusLabel(status),
      priority: item.priority || "",
      recurrence: item.recurrence && item.recurrence !== "none" ? item.recurrence : "",
      due: item.due || (item.dueDate ? formatDueDisplay(item.dueDate) : ""),
      dueDate: item.dueDate || item.due_date || "",
      done: Boolean(item.done),
      checklist: steps.total ? `${steps.completed}/${steps.total} done` : "",
    };
  });
}

/* The single prompt used by both AI paths, so the in-artifact `sample` call and the /api/ask
   route instruct the model identically. Each context line carries the fields the model actually
   reasons over (state, project, due), and the current date makes relative questions answerable. */
function buildAskPrompt(q, items, today) {
  const context = items
    .map((item) => {
      const label = [item.kind, item.status, item.priority].filter(Boolean).join("/");
      const bits = [item.title, item.sub].filter(Boolean).join(": ");
      const meta = [
        item.project ? `project: ${item.project}` : "",
        item.person ? `person: ${item.person}` : "",
        item.due ? `due: ${item.due}` : "",
        item.recurrence ? `repeats: ${item.recurrence}` : "",
        item.checklist ? `checklist: ${item.checklist}` : "",
        item.done ? "completed" : "",
      ].filter(Boolean);
      return `- [${label}] ${bits}${meta.length ? ` (${meta.join(", ")})` : ""}`;
    })
    .join("\n");
  return `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Today is ${today}. Be concise (2-4 sentences), specific, and reference relevant items by name. Use the status and due fields to judge what is current, overdue or still open. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context || "(none)"}\n\nQuestion: ${q}`;
}

/* Renders the AI answer for `q`. `opts.mount` is the element results are drawn into: the overlay's
   slot by default, or the header dropdown when the inline search box is the entry point. */
/* Guards against a slow response overwriting a newer one. Typing "gym" then "gym membership"
   fires two Ask calls; without this the slower first reply can land last and show an answer to a
   query the user has already moved on from. Each call takes a ticket and only the newest wins. */
let askRequestSeq = 0;

/* ---------- Cost control ----------

   Groq's free tier allows 8K input tokens/minute, and a full context eats several thousand, so the
   model is only asked when the query reads as a question. A lookup is answered by the ranked local
   search, which is instant, private and free. */

const MODEL_MIN_INTERVAL_MS = 6000;
const ASK_MODEL_MIN_LENGTH = 14;
let lastModelCallAt = 0;

// "gym" is a search; "what did I say about the gym membership" is a question.
const QUESTION_WORDS =
  /\b(what|whats|when|where|which|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|am|any|tell|remind|need|list|show|summar|explain|suggest|help)\b/i;

// Needs a question word and at least three words. A bare keyword is a lookup.
function shouldAskModel(q) {
  const text = String(q || "").trim();
  if (text.length < ASK_MODEL_MIN_LENGTH) return false;
  if (!QUESTION_WORDS.test(text)) return false;
  return text.split(/\s+/).length >= 3;
}

// Answers from local data alone, or null when the model should be asked instead. A real question
// always defers, even with no matches: the model can still say nothing relevant is captured. A
// lookup is answered here, including "no matches" — calling a model about a typo wastes quota.
function buildLocalAnswer(q) {
  const matches = searchMatches(q);
  if (shouldAskModel(q)) return null;
  if (!matches.length) return "No matching items in your captures.";
  const top = matches.slice(0, 5);
  const label = matches.length === 1 ? "1 match" : `${matches.length} matches`;
  return `Found ${label} for “${q.trim()}”:\n${top
    .map((m) => {
      const bits = [m.title, m.sub].filter(Boolean).join(" — ");
      return `• ${bits}`;
    })
    .join("\n")}`;
}

// False when a call was made recently; the caller keeps the local answer instead.
function modelCallAllowed() {
  const now = Date.now();
  if (now - lastModelCallAt < MODEL_MIN_INTERVAL_MS) return false;
  lastModelCallAt = now;
  return true;
}

/* ---------- Local model (Ollama) ----------
   A free model on this machine. It cannot live in /api/ask: that runs on Vercel and cannot reach
   localhost, so the browser talks to Ollama directly. Prompts and answers never leave the device.

   Reachability is probed once and remembered for the session. Without that, a machine with no
   Ollama would pay a doomed request on every question. */
const LOCAL_MODEL_KEY = "everything_local_model";
const LOCAL_MODEL_URL = "http://localhost:11434";
const LOCAL_MODEL_CONTEXT = 8192;
/* Generous, because a model on CPU is slow. Only reached when Ollama is already up: a refused
   connection fails immediately rather than sitting out the clock. */
const LOCAL_MODEL_TIMEOUT_MS = 45000;

let localModelSession = null;

function localModelConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(LOCAL_MODEL_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  return {
    enabled: saved.enabled !== false,
    baseUrl: String(saved.baseUrl || LOCAL_MODEL_URL).replace(/\/+$/, ""),
    model: String(saved.model || ""),
  };
}

function saveLocalModelConfig(patch) {
  const next = { ...localModelConfig(), ...patch };
  try {
    localStorage.setItem(LOCAL_MODEL_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the setting just does not persist */
  }
  localModelSession = null; // the new settings need a fresh probe
  return next;
}

/* Cloudflare's quick tunnel hands out a fresh random address every time cloudflared restarts, so a
   saved one silently goes stale with nothing actually broken. That one fact turns a baffling "not
   reachable" into an instruction, and it is worth recognising by name. */
const QUICK_TUNNEL_HOST = /\.trycloudflare\.com$/i;

/* cloudflared prints a banner with the address buried in the middle of it, so pasting the whole
   line — which is what people actually do — has to work. Pulls the first https:// address out of
   whatever was pasted and drops the trailing slash. */
function normaliseLocalModelUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s"'<>)\]]+/i);
  const found = (match ? match[0] : raw).replace(/\/+$/, "");
  return /^https?:\/\//i.test(found) ? found : "";
}

/* `reason` is written for the Settings card, so a failure has to say which of the several things
   that can go wrong actually went wrong — "not reachable" alone sends people to check the wrong
   one, and these are the three that really happen. */
function localModelFailureReason(baseUrl) {
  const host = String(baseUrl || "")
    .replace(/^https?:\/\//i, "")
    .split("/")[0];

  if (QUICK_TUNNEL_HOST.test(host)) {
    return (
      "That is a quick-tunnel address, and Cloudflare gives a new one every time cloudflared " +
      "restarts. Copy the address cloudflared is printing now and paste it above."
    );
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) {
    return "Not reachable. Start Ollama, and add this site's address to OLLAMA_ORIGINS — the browser blocks the call otherwise.";
  }
  return "Not reachable. Check that Ollama is running, that the address is right, and that this site is listed in OLLAMA_ORIGINS.";
}

/* `reason` is written for the Settings card, so a failure says what to do about it. */
async function localModelStatus(force = false) {
  if (localModelSession && !force) return localModelSession;
  const cfg = localModelConfig();
  if (!cfg.enabled) {
    return (localModelSession = { reachable: false, models: [], reason: "Turned off" });
  }
  if (!cfg.model) {
    return (localModelSession = { reachable: false, models: [], reason: "Choose a model" });
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/api/tags`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => m.name || m.model).filter(Boolean)
      : [];
    localModelSession = {
      reachable: true,
      models,
      reason: models.length ? "" : "Reachable, but no models are installed",
    };
  } catch {
    localModelSession = {
      reachable: false,
      models: [],
      reason: localModelFailureReason(cfg.baseUrl),
    };
  }
  return localModelSession;
}

/* Returns the model's text, or null on any failure so the caller falls through to the cloud. */
async function localModelComplete(messages, { json = false } = {}) {
  const status = await localModelStatus();
  if (!status.reachable) return null;
  const { baseUrl, model } = localModelConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        // Ollama streams by default, which would arrive as many JSON lines rather than one answer.
        stream: false,
        // Constrained decoding, so a small model returns parseable JSON for smart capture.
        ...(json ? { format: "json" } : {}),
        options: { num_ctx: LOCAL_MODEL_CONTEXT },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const text = typeof data?.message?.content === "string" ? data.message.content.trim() : "";
    return text || null;
  } catch {
    // Stop for the session: a model that just failed or timed out would cost the same again.
    localModelSession = { reachable: false, models: [], reason: "The local model did not answer" };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const LOCAL_MODEL_SYSTEM =
  "You answer questions about the user's own captured items. Be concise (2-4 sentences), " +
  "specific, and reference items by name. If the context has nothing relevant, say so briefly.";

async function askAIlocal(q, contextPool, today) {
  return localModelComplete([
    { role: "system", content: LOCAL_MODEL_SYSTEM },
    { role: "user", content: buildAskPrompt(q, contextPool, today) },
  ]);
}

async function askAI(q, opts = {}) {
  const ticket = ++askRequestSeq;
  const extra = opts.extra || "";
  const mountId = opts.mount ? opts.mount.id : "aiAnswerSlot";

  /* Resolves the slot live rather than holding one node. The dropdown rebuilds its markup on every
     keystroke, so a captured node is detached by the time the answer arrives — which is what left
     the dropdown stuck on "Thinking…". */
  const slot = () => (mountId ? document.getElementById(mountId) : null);
  const first = slot();
  if (!first) return;
  // The brand mark, not a generic ring. This is the wait a person actually stares at — a model
  // round trip on a phone — and it was a line of static text, which is indistinguishable from a
  // hung app. The words stay, because "Thinking…" says what is happening and a moving shape only
  // says that something is; the motion is what proves the app is still alive.
  first.innerHTML = `<div class="ask-answer">${brandLoaderHTML({ label: "Thinking…", size: "md" })}</div>`;

  // Only a newer call supersedes this one; a re-render is not a newer question.
  const isSuperseded = () => ticket !== askRequestSeq;
  const show = (html) => {
    if (isSuperseded()) return;
    const target = slot();
    if (target) target.innerHTML = html;
  };

  const contextItems = searchMatches(q);
  const contextPool = askContextPool(q);

  // A lookup is answered locally: instant, private, no quota. This is also what stays on screen if
  // the model is skipped, throttled or offline.
  const localAnswer = buildLocalAnswer(q);
  const wantsModel = localAnswer === null;
  const callModel = wantsModel && modelCallAllowed();

  // Today, so relative questions ("today", "this week") are answerable.
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Results already listed by the caller should not be repeated above the AI answer.
  const buildSourcesHtml = () =>
    contextPool.length
      ? `
    <div class="ask-sources">
      <div class="ask-sources-label">SOURCES</div>
      ${contextPool
        .slice(0, 5)
        .map(
          (i) => `<div class="ask-source" onclick="${extra === "search-ask" ? "closeSearch()" : "closeAsk()"};openPanel('${i.id}')">
        <span>${kindIcon(i.kind)}</span><span class="ask-source-title">${escapeHtml(i.title)}</span>
      </div>`,
        )
        .join("")}
    </div>`
      : "";

  let sample = null;
  try {
    sample = window.claude ? await window.claude.use("sample") : null;
  } catch (e) {
    sample = null;
  }

  const renderFallback = (note) => {
    // Reuse the local answer rather than rebuilding a generic line.
    const body =
      localAnswer ||
      (contextItems.length
        ? `Based on what you've captured — ${escapeHtml(
            contextItems
              .slice(0, 3)
              .map((m) => m.title)
              .join("; "),
          )}.`
        : "No matching items in your captures.");
    const hint = note
      ? `<div class="ask-hint">${escapeHtml(note)}</div>`
      : "";
    // The dropdown already lists the matching items, so sources there would just repeat them.
    const sources = extra === "search-ask" ? "" : buildSourcesHtml();
    show(`<div class="ask-answer">${escapeHtml(body).replace(/\n/g, "<br>")}${hint}${sources}</div>`);
  };

  /* The local model is free and private, so it is tried before the cloud and is not subject to
     MODEL_MIN_INTERVAL_MS. That throttle exists to protect a free cloud tier's quota, which does
     not apply here, so gating it would throw away a free answer for no reason. */
  if (wantsModel) {
    const localAnswerText = await askAIlocal(q, contextPool, today);
    if (isSuperseded()) return;
    if (localAnswerText) {
      show(`<div class="ask-answer">${escapeHtml(localAnswerText)}${buildSourcesHtml()}</div>`);
      return;
    }
  }

  // A lookup, or a second question inside the rate-limit window. No network call at all.
  if (!callModel) {
    renderFallback(
      wantsModel ? "Showing your matching items — the AI answer is rate limited just now." : "",
    );
    return;
  }

  if (sample) {
    try {
      const result = await sample(buildAskPrompt(q, contextPool, today), {
        modelTier: "quick",
        onText: ({ text }) => {
          show(`<div class="ask-answer">${escapeHtml(text)}</div>`);
        },
      });
      show(`<div class="ask-answer">${escapeHtml(result.text)}${buildSourcesHtml()}</div>`);
      return;
    } catch (err) {
      /* fall through to API below */
    }
  }

  // A file:// page cannot reach the API at all, so say that instead of reporting a bare 403.
  if (isFileProtocol()) {
    renderFallback("Opened from a file — open the deployed site to use AI answers.");
    return;
  }

  try {
    const res = await apiFetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        items: askContextPayload(contextPool),
        today,
      }),
    });
    // The server returns a short, user-safe reason for 503 (no key configured) and 502
    // (upstream problem). Anything else is unexpected, so stay quiet and use local results.
    if (!res.ok) return renderFallback(await readAskError(res));
    const data = await res.json();
    if (data.answer) {
      show(`<div class="ask-answer">${escapeHtml(data.answer)}${buildSourcesHtml()}</div>`);
      return;
    }
    renderFallback();
  } catch (err) {
    renderFallback("Search is offline right now — showing your matching items.");
  }
}

/* Turns an /api/ask error response into one short line, and never throws.
   The server's `reason` (e.g. "groq:429 -> gemini:timeout") is appended so a failure can be
   diagnosed from the UI without opening DevTools. A platform-level failure (e.g. the function
   exceeding its duration limit) returns HTML rather than JSON, so the body is read as text
   first and the status code is still reported. */
async function readAskError(res) {
  let note = "Showing your matching items.";
  let data = null;
  try {
    const raw = await res.text();
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (res.status === 503) {
      note = "AI answers are off — add a model API key in Vercel to enable them.";
    } else if (res.status === 502) {
      note = "The AI provider is unavailable right now — showing your matching items.";
    } else if (typeof data?.error === "string" && data.error.length < 120) {
      note = data.error;
    }
    if (data?.reason) note += ` (${data.reason})`;
    else if (!data) note += ` (request failed, status ${res.status})`;
  } catch (e) {
    note += ` (request failed, status ${res.status})`;
  }
  console.warn("ask failed:", res.status, data);
  return note;
}
