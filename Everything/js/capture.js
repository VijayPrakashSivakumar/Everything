/* ---------- Capture modal ---------- */
/* The three ways a thought actually arrives. Everything else in this list is a *kind* — a filing
   decision — and the app makes that decision on its own from the sentence.

   Voice and Image sat at positions 10 and 11, behind ten organising chips, so the two inputs a
   person reaches for most were the hardest to find while the ones they almost never choose by hand
   filled the front of the row. That read as "capture is manual" when in fact a dictated sentence
   already reached the same understanding pipeline as a typed one. */
const CAPTURE_PRIMARY = ["text", "voice", "image"];
let captureMoreTypesOpen = false;

function toggleMoreTypes() {
  captureMoreTypesOpen = !captureMoreTypesOpen;
  /* Toggled, not re-rendered. The chips for both rows are written once when the sheet opens, and
     the only thing that changes here is which row is on screen — rebuilding the DOM from here would
     need the sheet's own render step, and getting that name wrong throws inside pickType, which is
     on the path of every single capture. */
  const row = document.getElementById("typeMoreRow");
  if (row) row.style.display = captureMoreTypesOpen ? "flex" : "none";
  const chip = document.getElementById("typeMoreChip");
  if (chip) chip.classList.toggle("active", captureMoreTypesOpen);
}

const CAPTURE_TYPES = [
  { id: "text", icon: "file-text", label: "Text" },
  { id: "task", icon: "check-square-2", label: "Task" },
  { id: "event", icon: "calendar-days", label: "Event" },
  { id: "memory", icon: "brain", label: "Memory" },
  { id: "waiting", icon: "hourglass", label: "Waiting for" },
  { id: "openloop", icon: "circle-help", label: "Open loop" },
  { id: "document", icon: "file-badge", label: "Document" },
  { id: "expense", icon: "receipt-indian-rupee", label: "Expense" },
  { id: "bill", icon: "calendar-clock", label: "Bill" },
  { id: "voice", icon: "mic", label: "Voice" },
  { id: "image", icon: "image", label: "Image" },
  { id: "file", icon: "paperclip", label: "File" },
  { id: "link", icon: "link", label: "Link" },
];
let mediaRecorder = null;
let recordedChunks = [];
let recordingSeconds = 0;
let recordingInterval = null;
let pendingBlob = null;
let pendingBlobExt = null;

/* Dictation languages. The browser recogniser only understands one language per session, so one of
   these has to be chosen before the first word arrives.

   It used to be chosen by the person — a chip tap on every capture — because inheriting
   navigator.language meant a Tamil or Hindi speaker with an English browser got English
   transcription and a garbled capture. That treated the symptom: the guess was wrong because
   nothing ever looked at what the person actually says or writes. It does now. See the detection
   block below; the chips remain as the correction path for when the guess is wrong.

   `tag` is the BCP-47 code the Web Speech API expects; `label` is shown in the picker.
   `hint` is a native-script example so the option is recognisable to the person speaking. */
const VOICE_LANGUAGES = [
  { tag: "en-IN", label: "English", hint: "English" },
  { tag: "ta-IN", label: "Tamil", hint: "தமிழ்" },
  { tag: "hi-IN", label: "Hindi", hint: "हिन्दी" },
  { tag: "te-IN", label: "Telugu", hint: "తెలుగు" },
  { tag: "kn-IN", label: "Kannada", hint: "ಕನ್ನಡ" },
  { tag: "ml-IN", label: "Malayalam", hint: "മലയാളം" },
];

/* ---------- Automatic language detection ----------

   Script is the one signal about language that cannot be guessed at: Tamil characters are Tamil
   whether they were dictated, typed or photographed, and reading them needs no model, no network
   and no key. So detection is script-based and runs over every piece of text the capture flow
   sees — a transcript, the sentence in the box, the words that came back from a picture.

   Latin text reports as English, because that is the only thing Latin letters can mean here, and
   it is what every recogniser already falls back to.

   Two rules keep this safe rather than clever:
     - it only ever corrects a guess the app made itself; a chip the person tapped is a decision
       and is never overridden (captureVoiceLangAuto / captureOcrLangAuto)
     - a detection is remembered, so the correction is needed at most once per person */
const CAPTURE_SCRIPT_LANGUAGES = [
  { re: /[\u0B80-\u0BFF]/, tag: "ta-IN", ocr: "ta", label: "Tamil" },
  { re: /[\u0900-\u097F]/, tag: "hi-IN", ocr: "hi", label: "Hindi" },
  { re: /[\u0C00-\u0C7F]/, tag: "te-IN", ocr: "te", label: "Telugu" },
  { re: /[\u0C80-\u0CFF]/, tag: "kn-IN", ocr: "kn", label: "Kannada" },
  { re: /[\u0D00-\u0D7F]/, tag: "ml-IN", ocr: "ml", label: "Malayalam" },
];
const CAPTURE_LATIN_TAG = "en-IN";

/* The language of a piece of text, or "" when the text carries no letters at all.
   Script wins outright — Tamil characters are Tamil no matter what. Latin text is
   checked for romanised Indian-language words first (Tanglish/Hinglish/etc: the way
   people actually dictate when the keyboard is English), and only falls back to
   English when nothing matches. This is what lets a Tamil speaker be heard even
   when the recogniser started in English: the first few Latin words betray the
   language and trigger a hot-swap. */
const CAPTURE_ROMAN_WORDS = [
  { re: /\b(nalla|illa|irukku|iruku|vanakkam|nandri|nanri|eppadi|enna|ungal|unakku|yen|inga|anga|ponga|vaanga|seri|illainga|sapadu|amma|appa)\b/i, tag: "ta-IN" },
  { re: /\b(aap|tum|aapka|tumhara|kya|kaise|accha|achha|nahi|haan|shukriya|dhanyavad|bhai|kaam|paani|khana|ghar|mera|tera|bahut|zaroor)\b/i, tag: "hi-IN" },
  { re: /\b(bagunnara|ela|emi|cheppu|avunu|kadhu|ledhu|dhanyavadalu|namaste|anna|akka|chelli|tammudu|intlo|bayata|tindi|nenu|nuvvu|chala|manchi)\b/i, tag: "te-IN" },
  { re: /\b(hegiddira|hegiddeera|yenu|yelli|illa|houdu|dhanyavada|namaskara|anna|akka|sari|oota|mane|nanna|ninna|bahala|chennagide)\b/i, tag: "kn-IN" },
  { re: /\b(sukhamano|enthina|evide|illa|athe|nanni|sheri|namaskaram|chetta|chechi|veed|kazhichu|bhakshanam|ente|ninte|valare|kollam)\b/i, tag: "ml-IN" },
];

function detectCaptureLanguage(text) {
  const value = String(text || "");
  if (!value.trim()) return "";
  for (const rule of CAPTURE_SCRIPT_LANGUAGES) if (rule.re.test(value)) return rule.tag;
  if (!/[A-Za-z]/.test(value)) return "";
  /* Romanised detection needs more than one stray word: "illa" inside "illness" or
     "anna" inside "annual" must not flip the language. Two hits, or one hit in a
     longer sentence, is the bar — short English phrases stay English. */
  const words = value.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let bestTag = "";
  let bestHits = 0;
  for (const entry of CAPTURE_ROMAN_WORDS) {
    const pattern = new RegExp(entry.re.source, "i");
    let hits = 0;
    for (const word of words) if (pattern.test(word)) hits += 1;
    if (hits > bestHits) {
      bestHits = hits;
      bestTag = entry.tag;
    }
  }
  if (bestHits >= 2 || (bestHits === 1 && words.length >= 4)) return bestTag;
  return CAPTURE_LATIN_TAG;
}

function captureLanguageLabel(tag) {
  if (!tag || tag === CAPTURE_LATIN_TAG) return "English";
  return CAPTURE_SCRIPT_LANGUAGES.find((rule) => rule.tag === tag)?.label || tag;
}

/* Voice tag → the two-letter tag the OCR packs are published under ("ta-IN" → "ta"). Null for
   anything unknown, so no caller can ask for a pack that does not exist — the same rule
   ocrLangCode() already applies to a stored value. */
function voiceTagToOcrTag(tag) {
  if (tag === CAPTURE_LATIN_TAG) return "en";
  const match = CAPTURE_SCRIPT_LANGUAGES.find((rule) => rule.tag === tag);
  return match ? match.ocr : null;
}

function ocrTagToVoiceTag(tag) {
  if (tag === "en") return CAPTURE_LATIN_TAG;
  const match = CAPTURE_SCRIPT_LANGUAGES.find((rule) => rule.ocr === tag);
  return match ? match.tag : "";
}

/* The language this person was last *seen* using, whichever way it arrived. One memory for the
   whole capture flow: a Tamil caption read once from a picture is also a reason to listen in
   Tamil next time, and vice versa. */
const CAPTURE_LANG_MEMORY_KEY = "everything_capture_lang";

function rememberedCaptureLanguage() {
  try {
    const stored = localStorage.getItem(CAPTURE_LANG_MEMORY_KEY);
    return VOICE_LANGUAGES.some((entry) => entry.tag === stored) ? stored : "";
  } catch (error) {
    // Private mode has no memory. The browser default is used, exactly as before.
    return "";
  }
}

function rememberCaptureLanguage(tag) {
  if (!VOICE_LANGUAGES.some((entry) => entry.tag === tag)) return;
  try {
    localStorage.setItem(CAPTURE_LANG_MEMORY_KEY, tag);
  } catch (error) {
    // Not worth failing a capture over: the next one simply guesses again.
  }
}


/* Chosen once per capture and reused, so the recorded audio and the transcript agree. Always a
   real BCP-47 tag: the auto mode lives in its own flag rather than in this variable, because this
   variable is what the recogniser is handed. */
let captureVoiceLang = "";
/* True until the person taps a language chip. While true a confident detection may correct the
   guess; a tap turns it off for this capture, which is what makes "tap to correct" stick. */
let captureVoiceLangAuto = true;
/* The same bargain for the picture reader: auto until a chip says otherwise. */
let captureOcrLangAuto = true;
/* The language actually used for the last dictation, saved onto the capture. */
let captureVoiceLanguage = "";

function defaultVoiceLang() {
  // Last seen first: the person's own captures know them better than their browser locale does,
  // and this is what turns a one-off correction into a permanent default.
  const remembered = rememberedCaptureLanguage();
  if (remembered) return remembered;
  const preferred = String(navigator.language || "").toLowerCase();
  const exact = VOICE_LANGUAGES.find((entry) => entry.tag.toLowerCase() === preferred);
  if (exact) return exact.tag;
  const base = preferred.split("-")[0];
  const loose = VOICE_LANGUAGES.find((entry) => entry.tag.toLowerCase().split("-")[0] === base);
  return loose ? loose.tag : "en-IN";
}

/* `manual` is false only from the sheet's own reset, which must not count as a correction. */
function pickVoiceLang(tag, manual = true) {
  if (tag === "auto") {
    captureVoiceLangAuto = true;
    captureVoiceLang = defaultVoiceLang();
  } else {
    captureVoiceLang = VOICE_LANGUAGES.some((entry) => entry.tag === tag) ? tag : defaultVoiceLang();
    if (manual) {
      captureVoiceLangAuto = false;
      // A tap is the strongest signal this flow ever gets, so it becomes the guess the next
      // capture starts from and the same correction is never needed twice.
      rememberCaptureLanguage(captureVoiceLang);
    }
  }
  syncVoiceLangChips();
}

/* The sheet opening is the one reset: auto again, starting from whatever was last seen. */
function resetVoiceLangForCapture() {
  captureVoiceLangAuto = true;
  pickVoiceLang(defaultVoiceLang(), false);
  syncVoiceTranslateRow();
}

function syncVoiceLangChips() {
  document
    .querySelectorAll("#voiceLangRow .type-chip")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.dataset.lang === "auto" ? captureVoiceLangAuto : el.dataset.lang === captureVoiceLang,
      ),
    );
}

function renderVoiceLanguages() {
  const row = document.getElementById("voiceLangRow");
  if (!row) return;
  if (!captureVoiceLang) captureVoiceLang = defaultVoiceLang();
  /* Auto is a chip, not a footnote: the app deciding is a visible state the person can see and
     take back, the same way every other automatic choice in this sheet is shown. */
  const autoChip =
    `<div class="type-chip ${captureVoiceLangAuto ? "active" : ""}" data-lang="auto" ` +
    `onclick="pickVoiceLang(${jsStr("auto")}, true)"><span>Auto</span></div>`;
  row.innerHTML =
    autoChip +
    VOICE_LANGUAGES.map(
      (entry) =>
        `<div class="type-chip ${entry.tag === captureVoiceLang ? "active" : ""}" data-lang="${entry.tag}" onclick="pickVoiceLang(${jsStr(entry.tag)}, true)"><span>${entry.hint}</span></div>`,
    ).join("");
}

/* Corrects the guess from the person's own words — and only from their own words: a tap on a
   chip outranks the detector for this capture. Returns the language switched to, or "". */
function syncDetectedCaptureLanguage(text) {
  if (!captureVoiceLangAuto) return "";
  const detected = detectCaptureLanguage(text);
  if (!detected || detected === captureVoiceLang) return "";
  captureVoiceLang = detected;
  rememberCaptureLanguage(detected);
  renderVoiceLanguages();
  return detected;
}


function setVoiceRecordLabel(label, icon) {
  const btn = document.getElementById("voiceRecordBtn");
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${icon || "mic"}" aria-hidden="true"></i><span id="voiceRecordLabel">${label}</span>`;
  refreshIcons();
}

/* The record button carries its state on the element (idle / recording / stopping) so the sheet
   can show which of the three it is in without parsing labels — the label says what a tap will
   do, the state says what is happening now. */
function setVoiceRecordState(state) {
  const btn = document.getElementById("voiceRecordBtn");
  if (btn) btn.dataset.state = state;
  syncCaptureMicState(state);
}

function setVoiceDictateLabel(label, icon) {
  /* One-click capture keeps a single visible button (voiceRecordBtn). The old standalone
     “Dictate” button is gone from the sheet, but this helper is kept so any legacy caller
     still updates the one capture button instead of failing silently. */
  const btn = document.getElementById("voiceDictateBtn") || document.getElementById("voiceRecordBtn");
  if (!btn) return;
  const labelId = btn.id === "voiceRecordBtn" ? "voiceRecordLabel" : "voiceDictateLabel";
  btn.innerHTML = `<i data-lucide="${icon || "mic"}" aria-hidden="true"></i><span id="${labelId}">${label}</span>`;
  refreshIcons();
}

/* The mic on the text box and the button in the Voice panel are two faces of one control, so
   both show the same state — idle, listening, converting — without either becoming a second
   source of truth. */
function syncCaptureMicState(state) {
  const mic = document.getElementById("captureMicBtn");
  if (!mic) return;
  mic.dataset.state = state;
  mic.setAttribute("aria-pressed", state === "recording" ? "true" : "false");
  mic.setAttribute(
    "aria-label",
    state === "recording"
      ? "Stop voice capture"
      : state === "stopping"
        ? "Converting speech to text"
        : "Start voice capture",
  );
}

/* Silence auto-stop, armed when the recogniser actually starts (never during the permission
   prompt — nobody should be cut off for reading a dialog) and re-armed by every word. */
function armVoiceSilenceStop() {
  clearVoiceSilenceStop();
  voiceSilenceTimer = setTimeout(handleVoiceSilence, voiceSilenceMs);
}
function clearVoiceSilenceStop() {
  clearTimeout(voiceSilenceTimer);
  voiceSilenceTimer = null;
}
function handleVoiceSilence() {
  clearVoiceSilenceStop();
  // A tap on Stop is already waiting on the last words — never race it with a second finish.
  if (voiceTranscriptionDone) return;
  if (!captureRecordWantListening && !captureRecordRecognition) return;
  settleVoiceCapture();
}

/* The one finish path — reached from a tap on Stop, from silence auto-stop, and from the
   3-second backstop. `voiceRecordingWasLive` remembers whether this capture got a recorder
   going, which is what the "no words" message and the private-reader offer hinge on. */
/* ---------- Optional translation ----------

   Recognition and translation are deliberately two different things. The words land in the box
   first, in the language they were spoken; only a target the person explicitly chose sends them
   to the model, and a failure keeps the original words with an honest message. The keys live on
   the server (same provider chain as Ask) — nothing secret is ever in this file. */
const VOICE_TRANSLATE_MEMORY_KEY = "everything_capture_translate";
/* null = not read from storage yet; "" = read, and translation is off. */
let captureVoiceTranslateTarget = null;

function rememberedVoiceTranslateTarget() {
  try {
    const stored = localStorage.getItem(VOICE_TRANSLATE_MEMORY_KEY);
    return VOICE_LANGUAGES.some((entry) => entry.tag === stored) ? stored : "";
  } catch (err) {
    // Private mode or blocked storage: the choice holds for this sheet, just not the next one.
    return "";
  }
}

function rememberVoiceTranslateTarget(tag) {
  try {
    if (tag) localStorage.setItem(VOICE_TRANSLATE_MEMORY_KEY, tag);
    else localStorage.removeItem(VOICE_TRANSLATE_MEMORY_KEY);
  } catch (err) {
    // Same as above: storage is a convenience, never a dependency.
  }
}

function syncVoiceTranslateRow() {
  if (captureVoiceTranslateTarget === null) captureVoiceTranslateTarget = rememberedVoiceTranslateTarget();
  const select = document.getElementById("voiceTranslateTarget");
  if (!select) return;
  // A target from an older build's list must not leave the select blank — off is the honest state.
  if (captureVoiceTranslateTarget && !Array.from(select.options).some((option) => option.value === captureVoiceTranslateTarget)) {
    captureVoiceTranslateTarget = "";
  }
  select.value = captureVoiceTranslateTarget;
}

function onVoiceTranslateChange(value) {
  captureVoiceTranslateTarget = VOICE_LANGUAGES.some((entry) => entry.tag === value) ? value : "";
  rememberVoiceTranslateTarget(captureVoiceTranslateTarget);
}

function voiceTagToTranslateName(tag) {
  const entry = VOICE_LANGUAGES.find((item) => item.tag === tag);
  return entry ? `${entry.label} (${entry.hint})` : "English";
}

async function translateVoiceText(text, sourceTag, targetTag) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await apiFetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "translate",
        text,
        source: sourceTag ? voiceTagToTranslateName(sourceTag) : "",
        target: voiceTagToTranslateName(targetTag),
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.translated) throw new Error(data.error || `translate:${res.status}`);
    return String(data.translated).trim();
  } finally {
    clearTimeout(timer);
  }
}

function maybeTranslateVoiceCapture(heard) {
  const target = captureVoiceTranslateTarget;
  if (!target || !heard) return;
  const sourceTag = captureVoiceLanguage || captureVoiceLang || "";
  // The same language twice is not translation — and asking a model for it invites it to
  // "helpfully" rewrite the words the person just said.
  if (sourceTag === target) return;
  const token = (voiceTranslateToken += 1);
  setVoiceRecordLabel("Translating…", "languages");
  setVoiceLiveTranscript(`Translating to ${voiceTagToTranslateName(target)}…`);
  translateVoiceText(heard, sourceTag, target)
    .then((translated) => {
      if (token !== voiceTranslateToken) return; // a newer capture owns the box now
      const input = document.getElementById("captureText");
      if (!input || !translated) return;
      // The original-language words are replaced by the translation — the mode the person
      // chose — while the live line keeps both, so nothing the microphone heard is invisible.
      input.value = [voiceTranscriptBase, translated].filter(Boolean).join(" ");
      setVoiceLiveTranscript(
        `Heard “${heard}” — translated to ${voiceTagToTranslateName(target)}: “${translated}”`,
      );
      onCaptureInput();
    })
    .catch(() => {
      if (token !== voiceTranslateToken) return;
      setVoiceLiveTranscript(
        `Heard “${heard}”. Translation is unavailable right now — the original words were kept. Tap the mic to speak again.`,
      );
    })
    .finally(() => {
      if (token === voiceTranslateToken) setVoiceRecordLabel("Capture again", "mic");
    });
}

function settleVoiceCapture() {
  clearTimeout(voiceTranscriptionStopTimer);
  voiceTranscriptionStopTimer = null;
  voiceTranscriptionDone = null;
  /* Read the settled flag first: stopVoiceTranscription clears the want-flag and nulls onend,
     so calling it before checking would report silence even when words arrived. */
  const heard = voiceTranscript.trim();
  stopVoiceTranscription();
  // Silence (or the backstop) can finish a capture without a tap, so the recorder must be
  // closed here too — an abandoned capture must not keep the microphone open. On the tap
  // path this is a no-op: the tap already stopped it.
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  voiceTranscriptionSettled = true;
  setVoiceRecordState("idle");
  setVoiceRecordLabel(heard ? "Capture again" : "Capture voice", "mic");
  if (!heard) {
    setVoiceLiveTranscript(
      voiceRecordingWasLive
        ? "Nothing was heard in that recording. The audio is saved — type what you meant instead. Tap the mic to try again."
        : "Nothing was heard. Type what you meant instead. Tap the mic to try again.",
    );
    /* No words came back from the live recogniser: either this browser has none (Firefox), or
       it failed. Offer the private, on-device reader over the same recording — the one thing
       the Web Speech API cannot do. Shown only now, so the primary path stays the default. */
    setVoiceLocalSttVisible(voiceRecordingWasLive);
    return;
  }
  setVoiceLocalSttVisible(false);
  // The waiting state replaced whatever the last result showed; put the words back.
  setVoiceLiveTranscript(`Heard: “${heard}”`);
  // Translation is a separate, opt-in step and never blocks or replaces the transcript: the
  // words are already in the box before it starts, and they stay there if it fails.
  maybeTranslateVoiceCapture(heard);
}

function setVoiceDictationStatus(message) {
  const status = document.getElementById("voiceDictationStatus");
  if (status) status.textContent = message || "";
}

function stopVoiceDictation() {
  const recognition = captureVoiceRecognition;
  captureVoiceRecognition = null;
  captureVoiceActive = false;
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.stop();
    } catch (error) {
      // Recognition may already be stopped by the browser.
    }
  }
  setVoiceDictateLabel("Capture voice", "mic");
}

function toggleVoiceDictation() {
  if (captureVoiceActive) {
    stopVoiceDictation();
    setVoiceDictationStatus("Dictation stopped.");
    return;
  }
  if (captureDialogue.answering) {
    toggleCaptureAnswerDictation();
    return;
  }
  setVoiceDictationStatus("Use Capture voice to record and transcribe in one step.");
}


/* ---------- Voice: record and understand in one tap ----------

   The Web Speech API reads the *live* microphone. It has no API for being handed a recorded file,
   so the recogniser cannot be pointed at a blob after the fact. That is why recording used to
   dead-end: the audio was saved as an attachment and nothing ever read it, and the only way to get
   words out was a second, separate "Dictate" button — a second recording of the same sentence.

   The fix is to stop treating them as two features. Both listeners run over the same moment:
   MediaRecorder keeps the audio, SpeechRecognition keeps the words. One tap, one permission, and
   the words land in the capture box where the existing smart-capture pipeline picks them up as if
   they had been typed. */
let captureRecordRecognition = null;
let captureRecordWantListening = false;
let captureRecordRestartTimer = null;
let voiceLangSwapCount = 0;
let voiceCaptureBusy = false;
let voiceTranscript = "";
let voiceTranscriptBase = "";
/* True once the recogniser has emitted its own end, and the function to run when it does. The
   browser is the only authority on when it has finished hearing the last word. */
let voiceTranscriptionSettled = false;
let voiceTranscriptionDone = null;
let voiceTranscriptionStopTimer = null;
/* Silence auto-stop. The recogniser is continuous, so without a deadline an abandoned capture
   keeps listening — and recording — until someone remembers to stop it. The window is long
   enough for a breath between sentences and is re-armed by every word, so it ends a forgotten
   capture, never a paused speaker. Mutable so a test can watch it fire. */
const VOICE_SILENCE_MS = 8000;
let voiceSilenceMs = VOICE_SILENCE_MS;
let voiceSilenceTimer = null;
/* True once any word has come back this session: silence before the first word is a person
   settling in, silence after it is a person who has finished. */
let voiceHeardWords = false;
/* Consecutive transport failures. Chrome's speech service answers `network` when offline, and an
   endless respawn behind "keep speaking" hides that truth instead of telling it. */
let voiceNetworkMisses = 0;
/* The microphone stream promise for the live capture — kept so a recognition `not-allowed` that
   arrives *before* the Android permission bridge answers can wait for the real answer instead of
   killing the words path over a denial the person never gave. */
let voiceMicPermission = null;
let voiceMicRetryUsed = false;
/* Whether THIS capture got a recorder going. The "no words" message and the private-reader offer
   hinge on it; a module-level flag is what lets silence auto-stop share the same finish path. */
let voiceRecordingWasLive = false;
/* Bumps when a newer capture starts, so a translation in flight can never write into the next
   capture's box. */
let voiceTranslateToken = 0;

function setVoiceLiveTranscript(text) {
  const live = document.getElementById("voiceLiveTranscript");
  if (live) live.textContent = text || "";
}

/* Writes the transcript into the capture box and re-runs the pipeline. This is the moment voice
   capture becomes a capture: until this runs, a recording was just an attachment. */
function applyVoiceTranscript(finalText) {
  voiceTranscript = finalText;
  const spoken = voiceTranscript.trim();
  const input = document.getElementById("captureText");
  input.value = [voiceTranscriptBase, spoken].filter(Boolean).join(" ");
  setVoiceLiveTranscript(spoken ? `Heard: “${spoken}”` : "");
  if (spoken) {
    /* The words have arrived in a script, so the language is no longer a guess. In auto mode the
       guess — and the language saved with this capture — is corrected to match what was actually
       heard, and the correction is said out loud rather than made in silence. A chip the person
       tapped leaves it alone: a decision outranks a detection. */
    const detected = syncDetectedCaptureLanguage(spoken);
    if (detected) {
      captureVoiceLanguage = detected;
      setVoiceLiveTranscript(
        `Heard: “${spoken}” — detected ${captureLanguageLabel(detected)}.`,
      );
    }
    onCaptureInput();
  }
}

/* Velora-shaped voice: transcription first, recording second.
   The Web Speech recogniser reads the live microphone on its OWN — it needs no
   getUserMedia stream, no MediaRecorder, no blob. So it starts FIRST, before any
   permission prompt for recording. If the recorder then fails (no MediaRecorder,
   denied mic, Android WebView quirk), the words are already flowing and the
   capture still works — exactly how Velora's listen() behaves. Recording is an
   attachment, never a gate. */
function startVoiceTranscription() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceLiveTranscript("This browser cannot turn speech into text here — the recording is still saved.");
    return false;
  }
  if (captureRecordRecognition) return true;
  captureRecordWantListening = true;

  if (!captureVoiceLang) captureVoiceLang = defaultVoiceLang();
  captureVoiceLanguage = captureVoiceLang;
  const input = document.getElementById("captureText");
  /* Selected text is the person pointing at what to replace; everything else is the person
     adding to what they already wrote. */
  const selection = input.selectionEnd > input.selectionStart ? [input.selectionStart, input.selectionEnd] : null;
  voiceTranscriptBase = (selection ? input.value.slice(0, selection[0]) + input.value.slice(selection[1]) : input.value).trim();
  voiceTranscript = "";
  voiceLangSwapCount = 0;
  voiceHeardWords = false;
  voiceNetworkMisses = 0;
  voiceMicRetryUsed = false;
  // A translation from the previous capture must never land in this one's box.
  voiceTranslateToken += 1;
  voiceTranscriptionSettled = false;
  voiceTranscriptionDone = null;
  clearTimeout(voiceTranscriptionStopTimer);

  let final = "";
  let interimSnapshot = "";
  const spawnRecognition = () => {
    if (!captureRecordWantListening) return false;
    // Words heard before a language hot-swap must survive the restart: the new session's
    // resultIndex starts over, so seed it from what was already on screen.
    final = `${interimSnapshot} `.replace(/^\s+/, "");
    interimSnapshot = "";
    const recognition = new Recognition();
    captureRecordRecognition = recognition;
    recognition.lang = captureVoiceLang;
    // Continuous because a capture is a sentence or two, and a recogniser that stops after one
    // pause returns half of what was said. Interim results so the sheet shows the words landing.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      setVoiceLiveTranscript("Listening… speak your capture.");
      // Only now — while a permission dialog is open, nobody is "silent", they are reading.
      armVoiceSilenceStop();
    };
    recognition.onresult = (event) => {
      // A superseded session (hot-swapped for another language, or stopped) must not keep
      // writing: its late results would duplicate words the current session already has.
      if (captureRecordRecognition !== recognition) return;
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) final += `${transcript} `;
        else interim += transcript;
      }
      const combined = `${final} ${interim}`.trim();
      // Every word pushes the silence deadline back: a pause mid-sentence is not the end.
      if (combined) voiceHeardWords = true;
      armVoiceSilenceStop();
      interimSnapshot = combined;
      if (captureVoiceLangAuto && interim) {
        const detected = detectCaptureLanguage(interim);
        if (detected && detected !== captureVoiceLang && voiceLangSwapCount < 2) {
          voiceLangSwapCount += 1;
          captureVoiceLang = detected;
          captureVoiceLanguage = detected;
          rememberCaptureLanguage(detected);
          renderVoiceLanguages();
          setVoiceLiveTranscript(`Heard ${captureLanguageLabel(detected)} — listening in ${captureLanguageLabel(detected)}…`);
          try {
            recognition.onend = null;
            recognition.stop();
          } catch (error) {
            // Already stopped; the spawn below replaces it.
          }
          captureRecordRecognition = null;
          applyVoiceTranscript(combined);
          clearTimeout(captureRecordRestartTimer);
          captureRecordRestartTimer = setTimeout(spawnRecognition, 150);
          return;
        }
      }
      applyVoiceTranscript(combined);
    };
    recognition.onerror = (event) => {
      // Same staleness rule as onresult: only the session the app is listening to may speak.
      if (captureRecordRecognition !== recognition) return;
      if (event.error === "aborted") {
        // The app stopped this session itself (a language swap, or the person tapped Stop).
        // Reporting it would replace the final words with a failure that never happened.
      } else if (event.error === "no-speech") {
        setVoiceLiveTranscript(
          voiceHeardWords
            ? "Paused — still listening…"
            : "Nothing was heard yet — keep speaking, or stop and type instead.",
        );
      } else if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        // On Android the WebView routes the recogniser's mic request through the same native
        // bridge as getUserMedia, so this `not-allowed` can arrive while the system dialog is
        // still open — a denial the person has not given yet. If the microphone promise is
        // still pending, wait for its answer: when the grant lands, listening resumes itself.
        if (!voiceMicRetryUsed && voiceMicPermission) {
          voiceMicPermission.then((micStream) => {
            if (!micStream || !captureRecordWantListening || captureRecordRecognition) return;
            voiceMicRetryUsed = true;
            setVoiceLiveTranscript("Microphone is ready — listening again…");
            clearTimeout(captureRecordRestartTimer);
            captureRecordRestartTimer = setTimeout(() => {
              if (captureRecordWantListening && !captureRecordRecognition && !voiceTranscriptionDone) spawnRecognition();
            }, 150);
          });
          return;
        }
        captureRecordWantListening = false;
        setVoiceLiveTranscript(
          "Microphone permission was denied — the recording is still saved. Allow the microphone for this site, then tap the mic to try again.",
        );
      } else if (event.error === "language-not-supported") {
        captureRecordWantListening = false;
        setVoiceLiveTranscript(
          "This browser cannot transcribe that language live — the recording is still saved, and the on-device reader can try it. Tap the mic to record again.",
        );
      } else if (event.error === "audio-capture") {
        setVoiceLiveTranscript("No microphone was found — the recording is still saved. Tap the mic to try again.");
      } else if (event.error === "network") {
        voiceNetworkMisses += 1;
        setVoiceLiveTranscript(
          voiceNetworkMisses > 2
            ? "The speech service keeps failing — check the connection, then tap the mic to try again."
            : "Speech service is unreachable — retrying on its own. The recording is still saved.",
        );
        // Three strikes: the service is genuinely gone. Stop honestly rather than looping
        // behind a "keep speaking" that can never be heard.
        if (voiceNetworkMisses > 2) captureRecordWantListening = false;
      } else {
        setVoiceLiveTranscript("Speech could not be transcribed — the recording is still saved. Tap the mic to try again.");
      }
    };
    recognition.onend = () => {
      // Only the live session's end means anything. A stale end arriving after a hot-swap
      // must not schedule a second respawn beside the session that replaced it.
      if (captureRecordRecognition !== recognition) return;
      const stillWanted = captureRecordWantListening && !voiceTranscriptionDone;
      captureRecordRecognition = null;
      if (stillWanted) {
        clearTimeout(captureRecordRestartTimer);
        captureRecordRestartTimer = setTimeout(() => {
          if (captureRecordWantListening && !captureRecordRecognition && !voiceTranscriptionDone) spawnRecognition();
        }, 250);
        return;
      }
      voiceTranscriptionSettled = true;
      clearTimeout(voiceTranscriptionStopTimer);
      voiceTranscriptionStopTimer = null;
      const done = voiceTranscriptionDone;
      voiceTranscriptionDone = null;
      if (done) done();
    };
    try {
      recognition.start();
      return true;
    } catch (error) {
      captureRecordRecognition = null;
      captureRecordWantListening = false;
      if (String(error?.name || "").toLowerCase().includes("invalidstate")) {
        clearTimeout(captureRecordRestartTimer);
        captureRecordRestartTimer = setTimeout(() => {
          if (captureRecordWantListening && !captureRecordRecognition) spawnRecognition();
        }, 300);
        return true;
      }
      setVoiceLiveTranscript("Speech recognition could not start — the recording can still be saved.");
      return false;
    }
  };

  return spawnRecognition();
}

function stopVoiceTranscription() {
  captureRecordWantListening = false;
  clearTimeout(captureRecordRestartTimer);
  clearVoiceSilenceStop();
  captureRecordRestartTimer = null;
  if (!captureRecordRecognition) return;
  const recognition = captureRecordRecognition;
  /* A graceful stop (the person tapped Stop and a finish is waiting) must keep onend
     intact so the browser's natural end delivers the last words to finish(). Only a
     hard abort — new capture, sheet close, hot-swap — nulls it. The want-flag is
     already false, so keeping onend can never re-spawn listening. */
  const graceful = Boolean(voiceTranscriptionDone);
  if (!graceful) captureRecordRecognition = null;
  try {
    if (!graceful) recognition.onend = null;
    recognition.stop();
  } catch (error) {
    // Already stopped by the browser; nothing to unwind.
  }
  if (!graceful) captureRecordRecognition = null;
}

async function toggleVoiceRecording() {
  if (captureVoiceActive) stopVoiceDictation();
  if (voiceCaptureBusy) return;
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  /* Stop is offered whenever *anything* is running — the recorder, the recogniser, or both.
     It used to ask only about the recorder, so a capture whose audio had failed (or had
     already ended) could not be stopped at all: the same button started a second capture
     over the one still listening. */
  const listening = Boolean(captureRecordRecognition);
  if (recording || listening) {
    /* Wait for the recogniser to actually finish instead of racing a timer.

       This used to wait 400ms and then check whether anything had been heard. The browser
       delivers the final transcript asynchronously, so a sentence that ended just before the
       tap was discarded and the app confidently reported silence — which is exactly what the
       person was told while they had been speaking the whole time. Timing cannot be fixed by
       guessing a longer number; the recogniser emits its own end, and that is the only honest
       signal that it has finished saying what it heard. */
    /* A live recogniser ends on its own once it has flushed its last words, and that end
       finishes the capture. But when there is no recogniser instance to end — Firefox, a
       denied permission, the gap between respawns — waiting can only ever hit the backstop,
       and the tap appears frozen for three seconds. Finishing immediately is what makes Stop
       instant in exactly the cases that used to feel broken.

       The settle itself lives at module level (settleVoiceCapture) because silence auto-stop
       and this tap must share one finish path — two finish paths is two last words. */
    if (!listening || voiceTranscriptionSettled) settleVoiceCapture();
    else {
      voiceTranscriptionSettled = true;
      voiceTranscriptionDone = settleVoiceCapture;
      setVoiceRecordState("stopping");
      setVoiceRecordLabel("Converting speech to text…", "loader-circle");
      setVoiceLiveTranscript("Converting speech to text…");
      try {
        // Ask the recogniser to wrap up now: the browser flushes its pending final results
        // (which arrive through onresult) and then ends — and that end runs the settle.
        // Waiting for a silence-based natural end instead is what made Stop feel like it lagged.
        captureRecordRecognition.stop();
      } catch (error) {
        // Already ended; the backstop below still runs the settle.
      }
      // Backstop only. onend is what normally fires this; the timer exists for the browser that
      // never delivers it, because a stuck recogniser must not leave the sheet mid-reset.
      voiceTranscriptionStopTimer = setTimeout(settleVoiceCapture, 3000);
    }
    if (recording) mediaRecorder.stop();
    return;
  }
  /* ---------- Upfront availability checks ---------- */
  const hasSpeechRecognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasMediaRecorder = !!window.MediaRecorder;

  if (!hasSpeechRecognition && !hasMediaDevices) {
    setVoiceLiveTranscript("Your browser cannot record or transcribe voice — please type your capture instead.");
    setVoiceRecordState("idle");
    await alertDialog({ title: "Voice not available", body: "This browser does not support speech recognition or microphone access. Use the text input to create tasks, events and notes." });
    return;
  }
  if (!hasSpeechRecognition) {
    setVoiceLiveTranscript("This browser cannot transcribe speech — the recording will still be saved if your microphone works.");
  } else if (!hasMediaDevices || !hasMediaRecorder) {
    setVoiceLiveTranscript("This browser cannot record audio — speech-to-text will still work if the recogniser can start.");
  }

  let stream = null;
  /* The guard goes up before the permission prompt, not after it: two taps during the prompt
     used to both get past this check and race two recorders over one microphone. */
  voiceCaptureBusy = true;
  voiceRecordingWasLive = false;
  try {
    /* Velora order: words FIRST, audio second. The recogniser needs no stream, so it
       starts before getUserMedia — on a phone where the recorder fails, the words are
       already on screen instead of the whole capture dying at the permission prompt. */
    const transcriptionLive = startVoiceTranscription();
    try {
      const micStreamPromise = navigator.mediaDevices.getUserMedia({ audio: true });
      // Kept so a recognition `not-allowed` that lands before the system dialog is answered
      // can wait for the real answer and resume — see the not-allowed branch above.
      voiceMicPermission = micStreamPromise.then((micStream) => micStream, () => null);
      stream = await micStreamPromise;
      // The sheet can be closed while the permission prompt is open. A capture nobody can see
      // must not keep the microphone warm: the stream is stopped rather than promoted.
      const sheet = document.getElementById("captureModal");
      if (sheet && !sheet.classList.contains("open")) {
        stream.getTracks().forEach((track) => track.stop());
        stopVoiceTranscription();
        voiceMicPermission = null;
        return;
      }
    } catch (micError) {
      // The microphone prompt was denied or has no device. Velora keeps listening anyway
      // when it can and says plainly what happened — the words path is independent.
      if (transcriptionLive) {
        setVoiceLiveTranscript("Listening… speak your capture. (Audio attachment unavailable — words still work.)");
        setVoiceRecordState("recording");
        setVoiceRecordLabel("Stop capture", "square");
      } else {
        stopVoiceTranscription();
        setVoiceRecordState("idle");
        const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
        const hasMD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
        if (!hasSR && !hasMD) {
          await alertDialog({ title: "Voice unavailable", body: "This browser cannot record audio or transcribe speech. Use the text input to create tasks, events and notes instead." });
        } else if (!hasSR) {
          await alertDialog({ title: "Microphone blocked", body: "Speech recognition is not available in this browser, and microphone access was denied. You can still type your capture." });
        } else if (!hasMD) {
          await alertDialog({ title: "Microphone unavailable", body: "This browser cannot access the microphone. Speech recognition may still work — try tapping the mic again. Otherwise, type your capture instead." });
        } else {
          await alertDialog({ title: "Microphone blocked", body: "Everything could not reach the microphone. Check the browser permission for this site, then try again." });
        }
      }
      return;
    }
    recordedChunks = [];
    try {
      const mimeType =
        (window.MediaRecorder?.isTypeSupported?.("audio/webm;codecs=opus") && "audio/webm;codecs=opus") ||
        (window.MediaRecorder?.isTypeSupported?.("audio/webm") && "audio/webm") ||
        (window.MediaRecorder?.isTypeSupported?.("audio/mp4") && "audio/mp4") ||
        "";
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const type = mimeType || "audio/webm";
        const blob = new Blob(recordedChunks, { type });
        pendingBlob = blob;
        pendingBlobExt = ext;
        document.getElementById("voicePreview").src = URL.createObjectURL(blob);
        document.getElementById("voicePreview").style.display = "block";
        clearInterval(recordingInterval);
        document.getElementById("voiceTimer").textContent = "";
        setVoiceRecordLabel("Capture again", "mic");
        stream.getTracks().forEach((t) => t.stop());
      };
      mediaRecorder.start(500);
      voiceRecordingWasLive = true;
      recordingSeconds = 0;
      recordingInterval = setInterval(() => {
        recordingSeconds++;
        document.getElementById("voiceTimer").textContent =
          `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
      }, 1000);
    } catch (recordError) {
      // getUserMedia succeeded, so the microphone itself works: what failed is recording from
      // it. The words are already flowing, so the message must not claim the microphone is
      // blocked or leave the person thinking nothing is happening.
      mediaRecorder = null;
      setVoiceLiveTranscript("This browser cannot save the audio — your words are still being captured.");
    }
    // A fresh recording clears the previous one's private-reader offer; it is reshown only if this
    // recording also comes back with no words.
    setVoiceLocalSttVisible(false);
    setVoiceRecordState("recording");
    setVoiceRecordLabel("Stop capture", "square");
  } catch (e) {
    stopVoiceTranscription();
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (!mediaRecorder || mediaRecorder.state !== "recording") mediaRecorder = null;
    setVoiceRecordState("idle");
    const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasMD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!hasSR && !hasMD) {
      await alertDialog({ title: "Voice unavailable", body: "This browser cannot record audio or transcribe speech. Use the text input to create tasks, events and notes instead." });
    } else if (!hasSR) {
      await alertDialog({ title: "Voice not available", body: "Speech recognition is not available in this browser. You can still type your capture to create tasks, events and notes." });
    } else if (!hasMD) {
      await alertDialog({ title: "Microphone unavailable", body: "This browser cannot access the microphone. Speech recognition may still work — try tapping the mic again. Otherwise, type your capture instead." });
    } else {
      await alertDialog({ title: "Microphone blocked", body: "Everything could not reach the microphone. Check the browser permission for this site, then try again." });
    }
  } finally {
    voiceCaptureBusy = false;
  }
}

/* ---------- Private, on-device speech recognition (fallback) ----------

   The Web Speech API is the primary path because it is instant and, on Indian languages, more
   accurate than anything that runs on the device. It has two hard limits that matter here:

     - it is not in Firefox at all, and is unreliable in Chromium forks and embedded browsers, so a
       whole slice of users gets no transcript from it;
     - it sends the audio to the browser vendor's servers, which is the opposite of the promise the
       rest of this capture flow keeps — "the image never leaves the device" (see the OCR note below).

   This is the private, offline fallback for both cases: Whisper compiled to WebAssembly through
   transformers.js, running in this browser, with the audio never leaving the device and no API key
   or cost. It transcribes the *recorded* audio (MediaRecorder's blob), which the live Web Speech API
   cannot do, so it is a genuine second path rather than a duplicate of the first.

   It follows the same lazy, bounded, best-effort shape as the OCR engine below: the ~40 MB model is
   fetched only when this fallback is actually used, never on startup, a failed load degrades to the
   message people already know ("type it instead"), and every network wait has a ceiling. */
const SPEECH_ENGINE_SRC =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";
/* Multilingual Whisper — the base name (no ".en") is what covers Tamil, Hindi, Telugu, Kannada and
   Malayalam. whisper-tiny is the smallest multilingual model, ~40 MB, chosen for the same reason the
   OCR packs use their "_best_int" variant: on a phone on mobile data the download is the feature.
   The ".en" models would be a third of the size but are English-only, which is the exact failure the
   language detection above exists to avoid. */
const SPEECH_MODEL = "Xenova/whisper-tiny";
/* Whisper always hears 16 kHz mono, so the recorded blob is resampled to that before inference. */
const SPEECH_SAMPLE_RATE = 16000;
/* A first run downloads tens of megabytes. Deliberately generous — the same reasoning as
   OCR_LOAD_TIMEOUT_MS — because an early timeout would turn a working download into a failure. */
const SPEECH_LOAD_TIMEOUT_MS = 180000;
/* The resolved pipeline, kept once built. Null until first use, so the model is never touched
   during normal startup. */
let speechEngine = null;
let speechEnginePromise = null;

/* Loads transformers.js and builds the Whisper pipeline once, reusing it after that.

   Uses dynamic import() rather than a global: transformers.js ships as an ES module and, unlike
   Tesseract, defines no window global, so the OCR loader's script-tag-then-read-global pattern
   does not apply. The promise is memoised so a second tap reuses the first load, and is reset on
   failure so a later attempt can retry — the same contract as loadOcrEngine below. Resolves to the
   transcriber function, or rejects; never throws into the caller. */
function loadSpeechEngine() {
  if (speechEngine) return Promise.resolve(speechEngine);
  if (speechEnginePromise) return speechEnginePromise;
  speechEnginePromise = (async () => {
    const { pipeline, env } = await import(SPEECH_ENGINE_SRC);
    // Fetch model weights and WASM from the CDN (the default). No remote logging: the whole point
    // of this path is that nothing is phoned home.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    const transcriber = await pipeline("automatic-speech-recognition", SPEECH_MODEL);
    speechEngine = transcriber;
    return transcriber;
  })().catch((error) => {
    // Let a later attempt retry rather than caching the failure for the rest of the session.
    speechEnginePromise = null;
    throw error;
  });
  return speechEnginePromise;
}

function setVoiceLocalSttVisible(visible) {
  const button = document.getElementById("voiceLocalSttBtn");
  if (button) button.style.display = visible ? "block" : "none";
}

/* Decodes the recorded blob into the exact shape Whisper expects: a 16 kHz mono Float32Array.
   MediaRecorder writes whatever the browser chose (usually 48 kHz Opus), and handing Whisper that
   unchanged misreads the audio, so an OfflineAudioContext does the resample here rather than the
   model being blamed for a format it was never given. */
async function decodeAudioForWhisper(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext;
  const decodeCtx = new Ctx(1, 1, 44100);
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  const length = Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE));
  const offline = new Ctx(1, length, SPEECH_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/* Reads the recording the person just made, entirely on this device. This is the path a Firefox
   user falls back to, and anyone whose live recognition came back empty: the audio blob
   MediaRecorder already kept is read locally by Whisper — something the Web Speech API cannot do,
   which is what makes this a real second path rather than a repeat of the first.

   Best-effort and bounded, exactly like the OCR read: the model loads on first use, every wait has
   a ceiling, and any failure leaves the capture box untouched with a one-line reason rather than a
   broken sheet. The words, once read, enter the same pipeline as the live path so they are
   understood the same way. */
async function transcribeRecordingLocally() {
  if (!pendingBlob) {
    setVoiceLiveTranscript("Record something first, then this can read it on this device.");
    return;
  }
  const button = document.getElementById("voiceLocalSttBtn");
  if (button) button.disabled = true;
  setVoiceLiveTranscript("Preparing the private reader (first run downloads it, once)…");
  try {
    const audio = await withTimeout(
      decodeAudioForWhisper(pendingBlob),
      SPEECH_LOAD_TIMEOUT_MS,
      "Reading the recording timed out.",
    );
    const transcriber = await withTimeout(
      loadSpeechEngine(),
      SPEECH_LOAD_TIMEOUT_MS,
      "Loading the private reader timed out. Check your connection and try again.",
    );
    // The same language the person is capturing in, as the base code Whisper wants ("ta-IN" → "ta").
    // When the guess was never corrected (auto still on), let Whisper detect instead of forcing
    // English: forcing "en" on Tamil audio is exactly the garble this whole flow exists to avoid.
    const forced = voiceTagToOcrTag(captureVoiceLang);
    const transcribeOptions = { task: "transcribe" };
    if (!captureVoiceLangAuto && forced) transcribeOptions.language = forced;
    const output = await withTimeout(
      transcriber(audio, transcribeOptions),
      SPEECH_LOAD_TIMEOUT_MS,
      "Transcribing the recording timed out. You can still type what you meant.",
    );
    const spoken = String(output?.text || "").trim();
    if (!spoken) {
      setVoiceLiveTranscript(
        "The on-device reader could not make out any words. The audio is saved — type what you meant.",
      );
      return;
    }
    applyVoiceTranscript(spoken);
  } catch (error) {
    setVoiceLiveTranscript(
      "On-device transcription is unavailable right now. The audio is saved — type what you meant instead.",
    );
  } finally {
    if (button) button.disabled = false;
  }
}

function previewImageFile(input) {
  /* Two inputs now — camera and gallery — so the element is handed in rather than looked up.
     Resettable after use: picking the same file twice in a row must still fire `change`, which
     it does not while the control still holds the previous selection. */
  const element =
    input || document.getElementById("imageCameraInput") || document.getElementById("imageGalleryInput");
  const file = element?.files?.[0];
  if (!file) return;
  element.value = "";
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  const preview = document.getElementById("imagePreview");
  preview.src = URL.createObjectURL(file);
  preview.style.display = "block";
  // A new image invalidates any text read from the previous one.
  imageOcrText = "";
  setImageOcrStatus("");
}

/* ---------- Image text reading (OCR) ----------
   Runs entirely in the browser through Tesseract.js (WebAssembly): no API key, no cost, and
   the image never leaves the device — which is the whole point on a machine like this one.

   Everything here is opt-in and failure-tolerant. The library is fetched from a CDN only when
   the person actually presses "Read text", so a normal capture never pays for it, and if the
   download fails (offline, blocked CDN) the capture sheet carries on working exactly as before
   with a plain one-line explanation. */
const OCR_LANGUAGES = [
  { tag: "en", code: "eng", label: "English" },
  { tag: "ta", code: "tam", label: "தமிழ்" },
  { tag: "hi", code: "hin", label: "हिन्दी" },
  { tag: "te", code: "tel", label: "తెలుగు" },
  { tag: "kn", code: "kan", label: "ಕನ್ನಡ" },
  { tag: "ml", code: "mal", label: "മലയാളം" },
];

/* The tag above is what the chips and the stored setting use — two letters, matching the language
   codes the rest of the app already speaks (voice recognition uses the same). `code` is what
   tesseract's language packs are actually named, and those are three letters: ISO 639-2.

   This distinction was the entire reason image text reading did not work, and it is worth stating
   plainly because it is not an intermittent failure that a retry can paper over. The two-letter tag was
   passed straight through to the pack filename, so the app asked every host for files that do not
   exist anywhere:

     @tesseract.js-data/en/4.0.0_best_int/en.traineddata.gz     404   (no such package)
     @tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz   200   2,952,873 bytes of gzip

   All six languages verified in both forms: every two-letter name 404s, every three-letter name returns
   a real pack. So the read never had a chance — it was waiting on a file that could never arrive, and
   the 90-second timeout was the only thing that ever ended it.

   The old comment blamed an intermittent CDN and a slow pack. Both of those were real measurements, and
   both were measured against a URL that was already wrong. Nothing is intermittent here. */
/* Where the language packs come from.

   Our own origin, and that is deliberate rather than tidy. tesseract fetches its language data itself
   from whatever `langPath` names, with no retry and no second chance: one failed request and the read
   sits at "loading language traineddata 0%" until the timeout, 90 seconds after a request that gave up
   in under one. Retrying from the page cannot fix that, because the failing fetch belongs to the
   library and there is no hook for it.

   Pointed at this origin, the service worker does the fetching, where a mirror list, a gzip check and
   Cache Storage are all available. See OCR_LANG_MIRRORS in sw.js.

   The previous value, `https://tessdata.projectnaptha.com/4.0.0`, also named the full-size packs — eng
   is 10,923,060 bytes there against 2,952,873 for the `_best_int` variant now in use, measured at
   19.8s versus 2.9s for the same read. Both hosts are legitimate; the smaller variant is simply the
   better default for text read off a photograph.

   workerPath and corePath are pinned to exact versions, because those must match the library exactly
   and a floating tag there is the supply-chain risk the rest of this app now avoids. */
const OCR_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_WORKER_PATH = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js";
const OCR_CORE_PATH = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1";

/* The path tesseract is given, and the one the warm-up pre-caches. These two must agree exactly, and
   once they did not: the warm-up warmed a projectnaptha URL while the read fetched a jsDelivr one, so
   the pack was downloaded twice and the pre-cache bought nothing.

   tesseract appends "/<code>.traineddata.gz" to this itself, so it names a directory and not a file,
   and the `.gz` suffix is already handled — `gzip` defaults to true. */
const OCR_LANG_PATH = `${self.location.origin}/ocr-lang`;
const OCR_LANG_PACK = (code) => `${OCR_LANG_PATH}/${code}.traineddata.gz`;

/* Resolves a stored two-letter tag to the three-letter name its pack is published under.

   This goes through OCR_LANGUAGES rather than constructing a name from letters, so an unrecognised tag
   yields null and is reported as unsupported — instead of becoming a request for a file that cannot
   exist, which is the mistake being replaced: every tag was forwarded verbatim and every one 404'd. */
function ocrLangCode(tag) {
  return OCR_LANGUAGES.find((entry) => entry.tag === tag)?.code || null;
}

/* How many times a failed worker build is retried. Belt to the service worker's braces: the worker
   already tries three mirrors, so reaching this means all of them failed at once. One retry still earns
   its place because it costs a few seconds in a rare case and removes the only remaining way this
   feature can fail outright. Two attempts in total, so the worst case is bounded rather than a loop. */
const OCR_SETUP_ATTEMPTS = 1;

let captureOcrLang = "en";
let ocrScriptPromise = null;
let ocrWorker = null;
/* Which language ocrWorker was built for. Kept beside the worker itself because the two must always
   agree: a worker holds exactly one language model for its whole life, so this is what makes it
   possible to notice when a new choice has been made and the cached worker is stale. */
let ocrWorkerLang = null;
let ocrBusy = false;
let imageOcrText = "";
/* What the last read put in the box, so a second read can tell its own earlier result apart from work
   the person typed or edited. Without it, "replace the box" cannot tell the difference between
   throwing away something nobody wrote and throwing away something they did. */
let lastOcrWritten = "";

/* The first read fetches a language pack (eng, the largest of the six, is 2,952,873 bytes).

   Three things were missing, and all three cost the same thing: the user's afternoon. There was
   no ceiling, so a connection that neither loaded nor errored held the promise open for ever and
   the button sat on "Reading…"; there was no cancel, so the wait was compulsory; and there was no
   warm-up, so the download was charged to the person who actually pressed the button.

   OCR_LOAD_TIMEOUT_MS is deliberately generous: several megabytes on mobile data is genuinely slow,
   and a timeout that fires early would turn a working read into a failure. This is a backstop against
   "never", not a target — and a failure that fires it is now retried once, so the worst case is two
   of these rather than one followed by nothing. */
const OCR_LOAD_TIMEOUT_MS = 90000;
let ocrAbort = null;

/* A promise that settles by the clock instead of by the network. Every network wait in the OCR
   path goes through this, because the failure mode being defended against is not an error —
   it is silence, and silence never rejects a promise on its own. */
function withTimeout(promise, ms, message) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function setImageOcrCancelVisible(visible) {
  const button = document.getElementById("imageOcrCancelBtn");
  if (button) button.style.display = visible ? "block" : "none";
}

/* Aborts the in-flight read. The engine is a WebAssembly worker that cannot be interrupted by
   the timeout above — the timeout only stops *waiting* for it — so cancelling also terminates the
   worker, which is the only way the CPU actually stops. */
function cancelImageOcr() {
  if (!ocrBusy) return;
  ocrAbort?.abort();
  if (ocrWorker) {
    try {
      ocrWorker.terminate();
    } catch (error) {
      // A worker that has already gone is not a failure worth reporting.
    }
    ocrWorker = null;
    ocrWorkerLang = null;
  }
  ocrBusy = false;
  setOcrButtonBusy(false);
  setImageOcrCancelVisible(false);
  setImageOcrStatus("Reading stopped. The photo is still attached — type what it says if you need it now.");
}

/* Fetches the engine in the background when the capture sheet opens, so the download is spent while
   the person is reading the sheet rather than while they are waiting on a button. Swallowed
   completely: a failed warm-up is not an error the user has to dismiss, and the real read will
   retry it and report properly if it fails again. */
/* Pulls the language pack into the service worker's cache during idle time.

   The read is not the problem — the download on the tap is. Because the worker now serves these
   cache-first, anything fetched here makes the first real read fast instead of slow, and the cost
   lands while the capture sheet is open and idle rather than while someone watches a button.

   Fire-and-forget by design. This is a convenience, not part of reading an image: if it fails, is
   blocked, or is still running when the person presses the button, the read simply downloads it
   itself and nothing is lost. */
/* Whether the warm-up has been attempted. Kept separate from "succeeded" on purpose: a warm-up that
   failed once must not be retried on every capture sheet, but it must be retried when the reason it
   failed goes away — which is what a service worker that was not yet active is. */
let ocrLangWarm = false;

function warmOcrLanguage() {
  if (ocrLangWarm) return;
  if (!("serviceWorker" in navigator)) return;

  const send = (reg) => {
    /* The page cannot fill that cache itself: only the worker knows what it is called, and it changes
       whenever the shell version does. So the request goes to the worker that owns the cache and the
       worker does the fetching. Warming the chosen language and not merely English matters too — a
       Tamil or Hindi speaker warming the wrong pack would leave their first read exactly as slow.

       An unknown tag resolves to null, and nothing is sent: there is no pack to warm, and pretending
       otherwise would cache a URL that can only ever 404. */
    const code = ocrLangCode(captureOcrLang);
    if (!code) return false;
    if (!reg?.active) return false;
    reg.active.postMessage({
      type: "WARM_OCR_LANGUAGE",
      // The three-letter pack name, resolved here. Sending the two-letter tag warmed a URL that does
      // not exist, which is a second way of asking for a file that was never going to arrive.
      code: ocrLangCode(captureOcrLang),
    });
    return true;
  };

  /* This used to be posted once, on the first capture sheet, and that was the whole bug.

     The service worker registers during init and is NOT yet active when the capture sheet first
     opens — measured here: `active: null, controller: false` at that moment. `reg.active` is null, so
     `postMessage` was never sent, the promise branch checked `navigator.serviceWorker.controller`
     which was also false, and the warm-up was silently dropped. Nothing errored and nothing was cached,
     so the pack download landed on the button on every single read for the life of the install.

     So it is retried until it actually lands, and `ocrLangWarm` is set only once a post has really
     gone out. `ready` resolves as soon as there is an active worker, which is what makes the retry
     terminate rather than spin. */
  const attempt = () => {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      if (send({ active: controller })) ocrLangWarm = true;
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => {
        if (send(reg)) ocrLangWarm = true;
      })
      .catch(() => {
        // No service worker at all (private mode, or a browser without one). The read fetches the
        // pack itself, so there is nothing to warm and nothing to report.
      });
  };

  if (typeof requestIdleCallback === "function") requestIdleCallback(attempt, { timeout: 8000 });
  else setTimeout(attempt, 2500);

  // The first open is too early. Try again once the worker has taken control, which is the only
  // point at which a message can be delivered.
  navigator.serviceWorker.ready
    .then(() => {
      if (!ocrLangWarm) setTimeout(attempt, 0);
    })
    .catch(() => {});
}

/* Fetches the engine in the background when the capture sheet opens, so the work is spent while the
   person is reading the sheet rather than while they are waiting on a button. Swallowed completely:
   a failed warm-up is not an error the user has to dismiss, and the real read will retry it and
   report properly if it fails again. */
function warmOcrEngine() {
  warmOcrLanguage();
  if (window.Tesseract || ocrScriptPromise) return;
  try {
    withTimeout(loadOcrEngine(), OCR_LOAD_TIMEOUT_MS, "warm-up gave up").catch(() => {});
  } catch (error) {
    // Nothing to do — loadOcrEngine already resets itself so the next attempt retries.
  }
}

function setImageOcrStatus(message) {
  const status = document.getElementById("imageOcrStatus");
  if (!status) return;
  /* Reading an image is a genuinely long wait — the engine is fetched, a worker is built, then the
     page is recognised — and until now the only feedback was a sentence that changed three times
     without anything moving. The mark goes in front of those sentences while the work is happening,
     which is also what stops them reading as a stuck caption.

     Driven by wording rather than by a busy flag, because the same setter is used for the failure
     messages afterwards ("No text was found…"), and a spinner beside an error is a lie. Every message
     that means work is in flight is listed; anything else renders as plain text. */
  const inFlight = /^(Loading the text reader|Preparing|Reading the image|Recognising|Recognizing)/i.test(
    message || "",
  );
  if (inFlight) {
    status.innerHTML = brandLoaderHTML({ size: "sm" }) + `<span>${escapeHtml(message)}</span>`;
    return;
  }
  status.textContent = message || "";
}

function pickOcrLang(tag, manual = true) {
  if (tag === "auto") {
    captureOcrLangAuto = true;
    const remembered = voiceTagToOcrTag(rememberedCaptureLanguage());
    if (remembered && OCR_LANGUAGES.some((entry) => entry.tag === remembered)) {
      captureOcrLang = remembered;
    }
    syncOcrLangChips();
    return;
  }
  if (!OCR_LANGUAGES.some((entry) => entry.tag === tag)) return;
  captureOcrLang = tag;
  if (manual) {
    // The person has said what language this reads in, and the reader must not argue with that.
    // It is remembered too, so the same tap is never needed twice.
    captureOcrLangAuto = false;
    const voiceTag = ocrTagToVoiceTag(tag);
    if (voiceTag) rememberCaptureLanguage(voiceTag);
  }
  syncOcrLangChips();
}

function syncOcrLangChips() {
  document
    .querySelectorAll("#imageOcrLangRow .type-chip")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.dataset.lang === "auto" ? captureOcrLangAuto : el.dataset.lang === captureOcrLang,
      ),
    );
}

function renderOcrLanguages() {
  const row = document.getElementById("imageOcrLangRow");
  if (!row) return;
  // Auto first, as a visible state: the app choosing the language is automation the person can
  // see and take back, not a default they have to discover.
  const autoChip =
    `<div class="type-chip ${captureOcrLangAuto ? "active" : ""}" data-lang="auto" ` +
    `onclick="pickOcrLang(${jsStr("auto")}, true)"><span>Auto</span></div>`;
  row.innerHTML =
    autoChip +
    OCR_LANGUAGES.map(
      (entry) =>
        `<div class="type-chip ${entry.tag === captureOcrLang ? "active" : ""}" data-lang="${entry.tag}" onclick="pickOcrLang(${jsStr(entry.tag)}, true)"><span>${entry.label}</span></div>`,
    ).join("");
}

/* Loads Tesseract on first use. Resolves to the global, or rejects — never throws into the
   caller, so a failed download degrades to "type the text yourself". */
function loadOcrEngine() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (ocrScriptPromise) return ocrScriptPromise;
  ocrScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = OCR_SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.Tesseract
        ? resolve(window.Tesseract)
        : reject(new Error("The text reader loaded but did not start."));
    script.onerror = () => reject(new Error("The text reader could not be downloaded."));
    document.head.appendChild(script);
  }).catch((error) => {
    // Let a later attempt retry rather than caching the failure forever.
    ocrScriptPromise = null;
    throw error;
  });
  return ocrScriptPromise;
}

function setOcrButtonBusy(busy) {
  const button = document.getElementById("imageOcrBtn");
  if (!button) return;
  button.disabled = busy;
  const label = document.getElementById("imageOcrLabel");
  if (label) label.textContent = busy ? "Reading…" : "Read text from image";
  setImageOcrCancelVisible(busy);
}

/* Whether a service worker is in a position to answer /ocr-lang/*.

   This is the last gap in the fix, and it is a real one: a fetch only reaches the service worker if
   the worker is *controlling* the page. On the very first load after registration it is not — measured
   here, `controller: false` while the registration is still activating — so a read fired in that
   window is answered by the web server instead, which has no /ocr-lang route and replies 404. That is
   the identical failure the mirrors were introduced to remove, arriving by a different door.

   Waiting is the fix, and it is bounded: by the time someone has chosen an image, typed a note and
   pressed a button, the worker is normally in control long ago, so this resolves immediately in
   practice and only actually waits on a first-ever load. Without a service worker at all — private
   mode, or a browser without one — this resolves at once, because there is nothing to wait for and the
   read simply goes to the network. */
function waitForOcrLangEndpoint() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(false);
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return Promise.race([
    navigator.serviceWorker.ready
      .then(() => !!navigator.serviceWorker.controller)
      .catch(() => false),
    // A hard ceiling, so a browser that never activates its worker cannot stall the read itself.
    new Promise((resolve) => setTimeout(() => resolve(!!navigator.serviceWorker.controller), 10000)),
  ]);
}

/* Builds the worker, retrying once if the language pack does not arrive.

   The failure this covers is the one thing nothing upstream can catch: tesseract does not reject when
   its language pack fails to load — the promise simply never settles, and the read sits at "loading
   language traineddata 0%" until the app's timeout, 90 seconds after a request that failed in under a
   second. Waiting longer cannot help, because the wait is not the problem.

   So the worker is built through withTimeout as before, but a failure tears it down, drops the pack
   from the cache, and makes one more attempt. `code` is the three-letter pack name, already resolved
   by the caller, so this never has to guess. */
async function createOcrWorker(Tesseract, lang, attempt) {
  try {
    // Before the worker can answer /ocr-lang/*, it must control the page. Asking first costs nothing
    // when it already does, which is every load after the first.
    await waitForOcrLangEndpoint();
    // Optional chaining rather than a bare dereference: runImageOcr always sets this first, so the
    // check is satisfied in normal use. But a helper that throws on being called outside the button
    // is a helper nobody can call on its own, and that is exactly how the accuracy sweep below ended
    // up measuring nothing.
    if (ocrAbort?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    return await withTimeout(
      Tesseract.createWorker(lang, 1, {
        /* cacheMethod: "none" is the documented remedy for a hang this feature actually had.

           Tesseract caches the language pack in IndexedDB. When that write or read fails —
           private browsing, a full or restricted store, a stale entry from an older version — the
           worker sits at "loading language traineddata" with progress 0 and never moves. The library
           raises nothing: naptha/tesseract.js#901 reports errorHandler never firing, and #528 confirms
           a failure between createWorker and load() cannot be caught at all. So the promise simply
           never settles, which is why this read timed out identically on WiFi and on mobile data —
           it was never a bandwidth problem.

           Disabling that cache costs a re-download per session. The service worker still caches the
           response, so the bytes come back from Cache Storage on the next read; what is given up is
           IndexedDB, which is the part that hangs. */
        cacheMethod: "none",
        /* Spelled out rather than derived. Left to itself the library resolves these against its
           own bundle URL, and a service worker or an extension that answers for that origin can
           produce a script that loads but cannot importScripts (#851) — again with no error. */
        workerPath: OCR_WORKER_PATH,
        corePath: OCR_CORE_PATH,
        /* Our own origin. See the note on OCR_LANG_PATH: this is the whole reason the read no longer
           hangs when a CDN has a bad minute, because the service worker behind this URL retries across
           three mirrors instead of tesseract making one unretried request and giving up silently. */
        langPath: OCR_LANG_PATH,
        logger: (message) => {
          // Progress is reported by Tesseract as a 0..1 fraction per stage.
          if (message?.status && typeof message.progress === "number") {
            const percent = Math.round(message.progress * 100);
            setImageOcrStatus(`${message.status} ${percent}%`);
          }
        },
      }),
      OCR_LOAD_TIMEOUT_MS,
      "Preparing the text reader timed out. Try again, or type the note yourself.",
    );
  } catch (error) {
    // A cancelled read must not be retried: the person was told it stopped, and starting again would
    // be the app contradicting itself. The abort is thrown by this function, not by the network.
    if (error?.name === "AbortError") throw error;

    // A worker that failed to build is not reusable, and its half-built state is why a retry has to
    // start from nothing rather than call createWorker again on the same object.
    try { await ocrWorker?.terminate(); } catch (e) { /* already gone */ }
    ocrWorker = null;
    ocrWorkerLang = null;
    if (attempt >= OCR_SETUP_ATTEMPTS) throw error;

    setImageOcrStatus("The text reader did not start. Trying again…");
    // Drop anything already cached for this language, so the retry goes to the network rather than
    // being handed the same bad response again.
    try {
      if ("caches" in window) {
        // `lang`, not a name from somewhere else: this function takes the three-letter pack name as
        // its parameter, and referencing an undefined `code` here threw a ReferenceError that only
        // the retry path could reach — so the one moment a retry was needed, the retry never ran.
        const pack = OCR_LANG_PACK(lang);
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.endsWith("-ocr"))
            .map((name) => caches.open(name).then((cache) => cache.delete(pack))),
        );
      }
    } catch (e) {
      // A cache we cannot clear is not a reason to give up; the fetch below still happens.
    }

    return createOcrWorker(Tesseract, lang, attempt + 1);
  }
}

/* Prepares a photograph for reading. This is the accuracy fix, and it is here because Tesseract
   assumes it is looking at a clean scan: it binarises against white paper. A photograph has no white
   paper — it has off-white stock, a shadow from the hand holding it, and a highlight from whatever
   light was in the room. A region in shadow falls below the binariser's threshold and produces *no
   text at all* rather than poor text. That is the whole of the reported symptom: a few correct words
   and the rest missing or garbled.

   Measured on the same four lines of text, as a percentage of characters read correctly:

     no preprocessing                        21.3% shadowed   100.0% clean
     contrast stretch                        21.3%             100.0%
     upscale                                 21.3%             100.0%
     stretch + adaptive threshold            73.4%             100.0%
     stretch + adaptive + upscale            73.4%              97.9%
     divide by the lighting, fixed level     100.0%            100.0%
     divide by the lighting + Otsu           100.0%            100.0%   <- this one

   The technique: estimate the lighting by blurring the image heavily, divide the original by that
   estimate, then threshold. The blurred copy *is* the shadow, so dividing removes it and leaves text
   on flat white. The shadow's edge stops mattering entirely, which is what the adaptive threshold
   could not do — it recovered the shadowed lines but garbled the large bold heading, because its
   radius was smaller than a stroke of thick text. There is no radius here to mistune.

   Otsu picks the threshold that best separates ink from paper from the image's own histogram, so no
   magic constant is baked in. It scores the same as the best hand-picked level (170) and needs no
   guesswork; 190 shows what a badly chosen constant costs, at 56.8%.

   Three properties matter as much as the score:
   - a failure here falls back to the original blob, because a bad read beats no read
   - the blur runs on a 1/16-scale copy, so a wide radius in source pixels costs almost nothing
   - a huge photo is shrunk first: past a point, more pixels cost time and buy no accuracy */
async function prepareOcrImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    // 2200px on the long edge is well past what the model resolves, and bounds the work below.
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > 2200 ? 2200 / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const frame = ctx.getImageData(0, 0, width, height);
    const pixels = frame.data;
    const count = pixels.length / 4;

    /* The lighting, estimated on a 1/16-scale blurred copy and then scaled back up.

       Working small is the whole trick: the blur radius that matters is measured in *source* pixels,
       and doing it at 1/16 scale means a radius wide enough to swallow a shadow's edge costs almost
       nothing. This replaces a per-pixel neighbourhood loop that was both slower and less accurate. */
    const smallWidth = Math.max(8, Math.round(width / 16));
    const smallHeight = Math.max(8, Math.round(height / 16));
    const small = document.createElement("canvas");
    small.width = smallWidth;
    small.height = smallHeight;
    const smallCtx = small.getContext("2d", { willReadFrequently: true });
    if (!smallCtx) return blob;
    smallCtx.filter = "blur(6px)";
    smallCtx.drawImage(canvas, 0, 0, smallWidth, smallHeight);
    smallCtx.filter = "none";

    const lightCanvas = document.createElement("canvas");
    lightCanvas.width = width;
    lightCanvas.height = height;
    const lightCtx = lightCanvas.getContext("2d", { willReadFrequently: true });
    if (!lightCtx) return blob;
    lightCtx.imageSmoothingEnabled = true;
    lightCtx.imageSmoothingQuality = "high";
    lightCtx.drawImage(small, 0, 0, width, height);
    const light = lightCtx.getImageData(0, 0, width, height).data;

    /* Divide by the lighting, and build a histogram of the result in the same pass. The ratio is the
       fraction of the light reaching that pixel, so paper lands near 255 wherever it is and ink near
       0 — which is precisely what a shadow used to destroy. */
    const flat = new Float32Array(count);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < count; i += 1) {
      const p = i * 4;
      const value = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      const ambient = 0.299 * light[p] + 0.587 * light[p + 1] + 0.114 * light[p + 2];
      // ambient is near zero only where the blurred copy is black, i.e. a fully black region: there is
      // no light there to divide by, and clamping to white keeps a dark corner from becoming ink.
      const ratio = ambient > 1 ? (value / ambient) * 255 : 255;
      const v = ratio < 0 ? 0 : ratio > 255 ? 255 : ratio;
      flat[i] = v;
      histogram[Math.round(v)] += 1;
    }

    /* Otsu's method: the threshold maximising the variance between the ink and paper classes. It is
       chosen from this image's own histogram rather than fixed, which is why no constant appears
       below — a fixed level that suits one photo is 56.8% on the next one. */
    let total = 0;
    for (let t = 0; t < 256; t += 1) total += t * histogram[t];
    let belowSum = 0;
    let belowCount = 0;
    let threshold = 0;
    let bestVariance = -1;
    for (let t = 0; t < 256; t += 1) {
      belowCount += histogram[t];
      if (!belowCount) continue;
      const aboveCount = count - belowCount;
      if (!aboveCount) break;
      belowSum += t * histogram[t];
      const belowMean = belowSum / belowCount;
      const aboveMean = (total - belowSum) / aboveCount;
      const between = belowCount * aboveCount * (belowMean - aboveMean) * (belowMean - aboveMean);
      if (between > bestVariance) {
        bestVariance = between;
        threshold = t;
      }
    }

    const out = new Uint8ClampedArray(pixels);
    for (let i = 0; i < count; i += 1) {
      const v = flat[i] < threshold ? 0 : 255;
      const p = i * 4;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
    }

    ctx.putImageData(new ImageData(out, width, height), 0, 0);
    return canvas;
  } catch (error) {
    // A browser without createImageBitmap, a format it cannot decode, or an image too large to
    // allocate. None of those are worth failing the read over: the original is still readable, just
    // less accurately, which is a far better outcome than no text at all.
    return blob;
  }
}

/* The shape every recognised block is normalised into, so the first pass and a corrective second
   pass cannot drift into reading the same words differently. */
function cleanOcrText(raw) {
  return String(raw || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* One more pass with a worker built for a different language. Terminate, rebuild, recognise — the
   same sequence the first pass uses, in one place, so there is only one spot for the "a worker is
   built for one language and carries it for life" rule to live in. Returns "" when the corrected
   language has no pack, which the caller treats as "keep what we already have". */
async function rereadImageOcr(Tesseract, image) {
  const code = ocrLangCode(captureOcrLang);
  if (!code) return "";
  if (ocrWorker) {
    try { await ocrWorker.terminate(); } catch (e) { /* already gone */ }
    ocrWorker = null;
  }
  ocrWorker = await createOcrWorker(Tesseract, code, 0);
  ocrWorkerLang = code;
  return cleanOcrText((await ocrWorker.recognize(image))?.data?.text);
}

async function runImageOcr() {
  if (ocrBusy) return;
  if (!pendingBlob) {
    setImageOcrStatus("Choose an image first.");
    return;
  }

  /* Which language to read in. In auto mode the sentence already in the box is the best evidence
     there is — a Tamil caption over the photo means a Tamil photo — and the last language seen
     backs that up when the box is empty. A chip the person tapped says otherwise, and that
     outranks both. */
  if (captureOcrLangAuto) {
    const fromText = voiceTagToOcrTag(
      detectCaptureLanguage(document.getElementById("captureText")?.value || ""),
    );
    if (fromText && OCR_LANGUAGES.some((entry) => entry.tag === fromText)) {
      captureOcrLang = fromText;
      renderOcrLanguages();
    }
  }

  /* Resolved before anything is fetched, and reported rather than guessed at. An unrecognised tag can
     only come from a stale stored value or a hand-edited one; either way there is no pack to ask for,
     and quietly substituting English would read the wrong script and report success. */
  const code = ocrLangCode(captureOcrLang);
  if (!code) {
    setImageOcrStatus("That language is not supported for reading images. Pick another one.");
    return;
  }

  ocrBusy = true;
  ocrAbort = new AbortController();
  setOcrButtonBusy(true);
  try {
    /* The old wording — "Loading the text reader…" — was true and useless. The first run fetches
       the language pack; saying so is the difference between a wait the user understands and a
       button they assume is broken. */
    setImageOcrStatus(
      window.Tesseract
        ? "Preparing the text reader…"
        : "First run downloads the text reader (~3 MB, once). On mobile data this can take a minute — you can stop it below.",
    );
    const Tesseract = await withTimeout(
      loadOcrEngine(),
      OCR_LOAD_TIMEOUT_MS,
      "The text reader download timed out. Check the connection, or type the note yourself.",
    );
    if (ocrAbort.signal.aborted) return;

    setImageOcrStatus("Preparing the reader and language pack…");
    /* A worker is built for one language and carries it for life, so a cached worker from a previous
       language cannot be reused. This never showed up before only because the read never got far
       enough to build one; once reads actually work, switching language and pressing the button again
       would silently keep reading in the old one. Terminating is what makes the new choice take
       effect, and it is also the honest outcome: the engine holds the previous language's model. */
    if (ocrWorker && ocrWorkerLang !== code) {
      try { await ocrWorker.terminate(); } catch (e) { /* already gone */ }
      ocrWorker = null;
    }
    if (!ocrWorker) {
      ocrWorker = await createOcrWorker(Tesseract, code, 0);
      ocrWorkerLang = code;
    }
    if (ocrAbort.signal.aborted) return;

    setImageOcrStatus("Reading the image…");
    /* The photograph is prepared first. It is the single biggest accuracy lever measured — 21.3% to
       73.4% on a shadowed page, unchanged at 100% on a clean one — and it is the only step that can
       cost time, so it happens once, here, rather than inside the engine.

       The original is kept as a fallback rather than discarded. Preprocessing can occasionally make an
       image worse, and the only way to know it did is to read both. That costs a second pass, so it is
       paid only when the prepared image produced nothing at all: a partial read is kept as-is, because
       a worse-than-ideal transcript that the person can edit beats a second engine run and a longer
       wait. The cost of being wrong here is a slightly untidy result; the cost of always comparing is
       double the time on every read, which is the thing people actually notice. */
    const prepared = await prepareOcrImage(pendingBlob);
    if (ocrAbort.signal.aborted) return;

    const clean = cleanOcrText;

    let text = clean((await ocrWorker.recognize(prepared))?.data?.text);
    if (!text && prepared !== pendingBlob) {
      setImageOcrStatus("Reading the image again, unprocessed…");
      text = clean((await ocrWorker.recognize(pendingBlob))?.data?.text);
    }
    /* A cancelled read must not write its result: cancelImageOcr has already told the user it
       stopped, and text appearing after that would be the app contradicting itself. */
    if (ocrAbort.signal.aborted) return;

    if (!text) {
      setImageOcrStatus("No text was found. Try a clearer, closer photo, or type the note yourself.");
      return;
    }

    /* The read itself is the strongest signal of all: words that came back in Tamil were Tamil,
       whatever language the reader was started with. In auto mode the guess is corrected, the
       chips follow, and the image is read once more in the right language — once, because the
       first correction has already spent the only surprise there was, and a second would charge
       the same wait for nothing new. A chip the person tapped is never corrected at all. */
    if (captureOcrLangAuto) {
      const detectedOcrTag = voiceTagToOcrTag(detectCaptureLanguage(text));
      if (
        detectedOcrTag &&
        detectedOcrTag !== captureOcrLang &&
        OCR_LANGUAGES.some((entry) => entry.tag === detectedOcrTag)
      ) {
        const detectedLabel =
          OCR_LANGUAGES.find((entry) => entry.tag === detectedOcrTag)?.label || detectedOcrTag;
        captureOcrLang = detectedOcrTag;
        const detectedVoiceTag = ocrTagToVoiceTag(detectedOcrTag);
        if (detectedVoiceTag) rememberCaptureLanguage(detectedVoiceTag);
        renderOcrLanguages();
        setImageOcrStatus(`That reads like ${detectedLabel} — reading it again in ${detectedLabel}…`);
        const corrected = await rereadImageOcr(Tesseract, prepared);
        if (ocrAbort.signal.aborted) return;
        if (corrected) text = corrected;
      }
    }

    imageOcrText = text;
    // The recognised text becomes the capture body, so the existing smart-capture pipeline
    // treats a photographed receipt or note exactly like typed text: same suggestions, same
    // duplicate protection, same Task/Event/Reminder outcome. No new code path to maintain.
    const input = document.getElementById("captureText");
    /* Reading a second image used to overwrite the box outright, which threw away the first read -
       and anything typed or corrected since - with nothing said and no way back. Photographing a
       second receipt is an ordinary thing to want, and it silently deleted the first one.

       So the difference that matters is whose work is in the box. Text this same flow wrote, still
       untouched, is replaceable without asking: nobody composed it. Anything else is the person's,
       and replacing it is theirs to decide. Keeping both is offered first because photographing
       several receipts in a row is the normal reason to come back here. */
    const existing = input.value;
    const isOursAndUntouched = existing === lastOcrWritten;
    let append = false;
    if (existing.trim() && !isOursAndUntouched) {
      append = await confirmDialog({
        title: "Keep what is already here?",
        body: "The box is not empty, and what is in it is not the previous read. Choosing Keep adds this image on a new line. Choose Replace to use this image's text on its own.",
        confirmLabel: "Keep both",
        cancelLabel: "Replace",
      });
    }
    input.value = append ? `${existing.replace(/\s+$/, "")}\n\n${text}` : text;
    lastOcrWritten = append ? `${existing.replace(/\s+$/, "")}\n\n${text}` : text;
    setImageOcrStatus(
      append
        ? `Read ${text.length} characters and added it to what was already there. Edit anything that looks wrong, then save.`
        : `Read ${text.length} characters. Edit anything that looks wrong, then save.`,
    );
    onCaptureInput();
  } catch (error) {
    // Soft failure: the capture sheet must stay usable with no text read at all.
    setImageOcrStatus(
      `${error?.message || "Text reading failed."} You can still type the note yourself.`,
    );
    console.warn("image ocr failed:", error);
  } finally {
    ocrBusy = false;
    setOcrButtonBusy(false);
  }
}

function previewGenericFile() {
  const file = document.getElementById("genericFileInput").files[0];
  if (!file) return;
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  document.getElementById("fileNamePreview").textContent =
    `Selected: ${file.name}`;
}

async function uploadPendingBlob() {
  if (!pendingBlob || !sbUser) return null;
  const path = `${sbUser}/${cid()}.${pendingBlobExt}`;
  const { error } = await sb.storage.from("captures").upload(path, pendingBlob);
  if (error) {
    console.error("Upload failed:", error.message);
    return null;
  }
  const { data } = sb.storage.from("captures").getPublicUrl(path);
  return data.publicUrl;
}
let captureAutoDetected = false;
let captureScope = "shared";
let captureSmartEnabled = true;
let captureExtraction = null;
let captureSuggestionFields = {};
let captureDuplicate = null;
let captureQuestions = [];
/* The conversation itself: what has been asked, what the person has answered, and which value is
   being asked for right now. See the "Conversation engine" block above applyCaptureSlot(). */
let captureDialogue = {
  turns: [],
  filled: {},
  required: [],
  answering: false,
  shownSlot: "",
};
/* What the last reading produced, and the sentence it came from. A finished conversation hands
   these to the auto-create it just unblocked, so the same items are created without re-reading
   the sentence and without the model being asked a second time. */
let captureLastPlan = [];
let captureLastText = "";
/* A picture carried a date and the person has not yet said what it is. The auto-create waits on
   this: silently filing a photographed appointment card as a task is the one outcome nobody asked
   for, and it is not cheap to notice afterwards. */
let captureImageChoicePending = false;
/* Whether the free-text answer field is showing. Closed by default: the chips cover the ordinary
   case in one tap, and a permanently open field made the sheet look like a form again. */
let captureAnswerOpen = false;
/* The expiry read off a photographed document. Held separately from the field so "Clear suggestions"
   can restore the capture to how it was found, exactly as it does for the due date. */
let captureDocExpiry = "";
let capturePlan = []; // Extra items from the same sentence. See setCapturePlan.
let captureAgenda = []; // Agenda lines, saved as the main item's checklist steps.
let captureMainAsk = ""; // A question the model raised about the main item.
let captureAutoSaveTimer = null; // Pending "Done." for a sentence that read clearly.
let capturePlanTouched = false; // A row was corrected, so the app must not decide.
let captureVoiceRecognition = null;
let captureVoiceActive = false;
let captureVoiceFinal = "";
let captureVoiceBase = "";
let captureSaveInFlight = false;

/* ---------- One sentence, several things ----------
   One capture used to save exactly ONE item, so "meeting with the design team at 9, need to
   discuss the new app and send the proposal afterwards" lost everything after the first clause.
   Entry 0 drives the form (unchanged path), the rest become editable rows, and an "agenda"
   entry folds into the main item's checklist. Shown before saving, never saved behind the back. */
const CAPTURE_PLAN_LIMIT = 6;
const CAPTURE_PLAN_KIND_LABELS = {
  task: "Task",
  event: "Event",
  memory: "Memory",
  waiting: "Waiting for",
  openloop: "Open loop",
};
const CAPTURE_PLAN_KINDS = Object.keys(CAPTURE_PLAN_KIND_LABELS);
const CAPTURE_PLAN_SUB = {
  task: "Captured task",
  event: "Captured event",
  memory: "Memory",
  waiting: "Waiting for",
  openloop: "Open loop",
};
// Kinds whose title is work, so the reading may shorten it. A note, a link and media keep the
// person's own words, because there the wording is the content.
const CAPTURE_MODEL_TITLE_KINDS = new Set(["task", "event", "waiting", "openloop"]);

function normalisePlanEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const title = String(entry.title || "")
    .trim()
    .slice(0, 200);
  if (!title) return null;
  return {
    // "agenda" must survive normalisation, or setCapturePlan can no longer tell a talking
    // point (a step on the main item) from work of its own (a row of its own).
    kind: entry.kind === "agenda" || CAPTURE_PLAN_KINDS.includes(entry.kind) ? entry.kind : "task",
    title,
    dueDate: String(entry.dueDate || "").slice(0, 40),
    person: String(entry.person || "")
      .trim()
      .slice(0, 80),
    // Carried through so a row of its own is saved with the place the sentence gave it, rather
    // than the whole plan losing its locations at the door.
    location: String(entry.location || "")
      .trim()
      .slice(0, 80),
    project: String(entry.project || "")
      .trim()
      .slice(0, 80),
    priority: ["high", "medium", "low"].includes(entry.priority) ? entry.priority : "",
    ambiguous: String(entry.ambiguous || "")
      .trim()
      .slice(0, 200),
  };
}

function setCapturePlan(items, mainAsk = "") {
  const entries = (Array.isArray(items) ? items : []).map(normalisePlanEntry).filter(Boolean);
  // Entry 0 is already on the form, so its question has nowhere else to appear.
  captureMainAsk = String(mainAsk || "").trim().slice(0, 200);
  // Agenda lines are not work of their own, so they become steps on the main item rather than
  // extra rows to triage.
  captureAgenda = entries.filter((entry) => entry.kind === "agenda");
  capturePlan = entries
    .slice(1)
    .filter((entry) => entry.kind !== "agenda")
    .slice(0, CAPTURE_PLAN_LIMIT);
  renderCapturePlan();
}

function editCapturePlan(index, field, value) {
  const entry = capturePlan[index];
  if (!entry) return;
  // Correcting a row is a decision to keep control, so nothing may auto-save after it.
  capturePlanTouched = true;
  cancelAutoSave();
  if (field === "dueDate") {
    // A half-typed datetime-local value must clear the date, never become NaN.
    const parsed = value ? new Date(value) : null;
    entry.dueDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
    return;
  }
  if (field === "kind") entry.kind = CAPTURE_PLAN_KINDS.includes(value) ? value : entry.kind;
  else entry[field] = String(value || "").slice(0, 200);
}

function removeCapturePlan(index) {
  if (index < 0 || index >= capturePlan.length) return;
  capturePlan.splice(index, 1);
  capturePlanTouched = true;
  cancelAutoSave();
  renderCapturePlan();
}

/* "Save 4 items" makes the fan-out visible before it lands. */
function updateCaptureSaveLabel() {
  const button = document.getElementById("captureSaveBtn");
  if (!button || captureSaveInFlight) return;
  const total = 1 + capturePlan.length;
  button.textContent = total > 1 ? `Save ${total} items` : "Save";
}

/* ---------- Auto-create: "Done." ----------

   The product goal is that a clear sentence needs no Save click at all. It only earns that when
   the reading is unambiguous: every entry titled, typed and free of a question. One unclear
   entry and the sheet asks instead, which is why an ambiguous sentence still shows the plan.

   Guarded rather than trusted, because a capture is silent and therefore unforgiving:
     - text only (voice/image/file/link need their own inputs and an upload)
     - smart suggestions must still be on
     - a detected duplicate never auto-saves
     - editing any plan row cancels it
     - the text must be unchanged when the timer fires, so a fast typist is never auto-saved
     - undo is offered, so a wrong auto-create costs one tap */
const AUTO_SAVE_SETTLE_MS = 1400;

function capturePlanIsClear(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return false;
  return list.every((entry) => String(entry.title || "").trim() && entry.kind && !entry.ambiguous);
}

function cancelAutoSave() {
  if (!captureAutoSaveTimer) return;
  clearTimeout(captureAutoSaveTimer);
  captureAutoSaveTimer = null;
}

function scheduleAutoSave(items, text) {
  cancelAutoSave();
  // A file and a link are not re-read (there is nothing in them to read), so they are not decided
  // for either. Voice and image are: their transcript and their recognised text are understood the
  // same way a typed sentence is, and a clear one should save itself exactly as a typed one does.
  if (captureChannel === "file" || captureChannel === "link") return;
  if (!captureSmartEnabled) return;
  // A value is still being asked for, so the sentence is not finished with. Deciding now would
  // create it without the date the person is one word away from giving.
  if (captureDialogue.answering || captureDialogue.required.length) return;
  // Same reasoning for a picture that carried a date: the kind is still undecided.
  if (captureImageChoicePending) return;
  if (!capturePlanIsClear(items)) return;
  captureAutoSaveTimer = setTimeout(() => {
    captureAutoSaveTimer = null;
    const field = document.getElementById("captureText");
    // Kept typing, or already started correcting the plan: do not decide for them.
    if (!field || field.value.trim() !== text) return;
    if (captureDuplicate || capturePlanTouched || captureSaveInFlight) return;
    saveCapture(true, { auto: true });
  }, AUTO_SAVE_SETTLE_MS);
}

function pickScope(scope) {
  captureScope = scope;
  document
    .querySelectorAll("#visibilityRow .type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.scope === scope));
}
function openCapture() {
  captureType = "text";
  /* Reset with the rest of the sheet. A row left expanded by the previous capture makes the next one
     look like it needs choosing from thirteen options again, which is the thing being fixed. */
  captureMoreTypesOpen = false;
  /* Warm the image reader while the sheet is opening. The sheet is on screen and the person is
     reading it, so the first-run download is spent in the background rather than in
     front of them — which is what turns "stuck on Reading" into an instant result later. */
  warmOcrEngine();
  // The channel resets with it, or the next capture opens with the last one's voice recorder, image
  // panel or link field still on screen.
  captureChannel = "text";
  if (document.getElementById("sidebar").classList.contains("open"))
    toggleSidebar();
  captureAutoDetected = false;
  captureScope = "shared";
  captureSmartEnabled = true;
  captureExtraction = null;
  captureSuggestionFields = {};
  captureDuplicate = null;
  capturePlan = [];
  captureAgenda = [];
  captureMainAsk = "";
  capturePlanTouched = false;
  cancelAutoSave();
  renderCapturePlan();
  captureVoiceFinal = "";
  captureVoiceBase = "";
  stopVoiceDictation();
  pickScope("shared");
  const row = document.getElementById("typeRow");
  const primary = CAPTURE_TYPES.filter((t) => CAPTURE_PRIMARY.includes(t.id));
  const rest = CAPTURE_TYPES.filter((t) => !CAPTURE_PRIMARY.includes(t.id));
  const chip = (t) =>
    `<div class="type-chip ${t.id === captureType ? "active" : ""}" data-type="${t.id}" onclick="pickType(${jsStr(t.id)}, true)"><i data-lucide="${t.icon}"></i><span>${t.label}</span></div>`;

  /* Primary first, then a single "More types" control. The kinds stay one tap away and keep their
     labels and order — nothing is removed, only moved out of the way of the three that matter. */
  row.innerHTML = [
    ...primary.map(chip),
    `<div class="type-chip type-chip-more ${captureMoreTypesOpen ? "active" : ""}" id="typeMoreChip" onclick="toggleMoreTypes()"><i data-lucide="ellipsis" aria-hidden="true"></i><span>More types</span></div>`,
  ].join("");

  const moreRow = document.getElementById("typeMoreRow");
  if (moreRow) {
    moreRow.innerHTML = rest.map(chip).join("");
    moreRow.style.display = captureMoreTypesOpen ? "flex" : "none";
  }
  // Built from MONEY_CATEGORIES rather than typed into the markup, so the picker and the labels used
  // by the list and the report can never drift — one list, three readers.
  const categorySelect = document.getElementById("captureCategory");
  if (categorySelect) {
    categorySelect.innerHTML =
      '<option value="">Not specified</option>' +
      MONEY_CATEGORIES.map(
        (c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`,
      ).join("");
  }
  refreshIcons();
  document.getElementById("captureText").value = "";
  document.getElementById("captureText").placeholder = "What's on your mind?";
  document.getElementById("captureHint").textContent = "";
  captureQuestions = [];
  // A half-finished conversation must never leak into the next capture, or the sheet would open
  // still asking about the last sentence.
  resetCaptureDialogue();
  const questionCard = document.getElementById("captureQuestion");
  if (questionCard) {
    questionCard.hidden = true;
    questionCard.innerHTML = "";
  }
  document.getElementById("captureDuplicateWarning").hidden = true;
  document.getElementById("clearCaptureSuggestionsBtn").disabled = true;
  const smartToggle = document.getElementById("captureSmartEnabled");
  if (smartToggle) smartToggle.checked = true;
  populateProjectSelect();
  document.getElementById("captureModal").classList.add("open");
  lockPageScroll(true);
  document.getElementById("captureDueDate").value = "";
  document.getElementById("captureRecurrence").value = "none";
  document.getElementById("capturePriority").value = "";
  document.getElementById("capturePerson").value = "";
  // The place resets with the rest, and its block hides with it: a location left over from the
  // previous capture would be indistinguishable from one the reader had found for this one.
  const locationReset = document.getElementById("captureLocation");
  if (locationReset) locationReset.value = "";
  const locationFieldsReset = document.getElementById("captureLocationFields");
  if (locationFieldsReset) locationFieldsReset.style.display = "none";
  document.getElementById("voiceCaptureUI").style.display = "none";
  document.getElementById("imageCaptureUI").style.display = "none";
  document.getElementById("fileCaptureUI").style.display = "none";
  document.getElementById("linkCaptureUI").style.display = "none";
  document.getElementById("captureText").style.display = "block";
  document.getElementById("voicePreview").style.display = "none";
  document.getElementById("imagePreview").style.display = "none";
  document.getElementById("imageOcrStatus").textContent = "";
  setOcrButtonBusy(false);
  // Auto again for this picture, starting from the language last seen — so someone who only ever
  // photographs Tamil documents reads them in Tamil without ever touching a chip, and a chip they
  // did tap is still only a default rather than a lock.
  captureOcrLangAuto = true;
  const rememberedOcrLang = voiceTagToOcrTag(rememberedCaptureLanguage());
  if (rememberedOcrLang && OCR_LANGUAGES.some((entry) => entry.tag === rememberedOcrLang)) {
    captureOcrLang = rememberedOcrLang;
  }
  imageOcrText = "";
  lastOcrWritten = "";
  renderOcrLanguages();
  // Document fields reset with everything else, or the previous capture's expiry would be waiting
  // under the next one — and it would be indistinguishable from a value the person had typed.
  captureDocExpiry = "";
  ["captureDocType", "captureDocExpires", "captureDocIssuer", "captureDocNumber", "captureIssuedOn"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const docFieldsReset = document.getElementById("captureDocFields");
  if (docFieldsReset) docFieldsReset.style.display = "none";
  ["captureAmount", "captureSpentOn", "captureMerchant"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const categoryReset = document.getElementById("captureCategory");
  if (categoryReset) categoryReset.value = "";
  const moneyFieldsReset = document.getElementById("captureMoneyFields");
  if (moneyFieldsReset) moneyFieldsReset.style.display = "none";
  ["captureBillAmount", "captureBillDue", "captureBillMerchant"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const billTypeReset = document.getElementById("captureBillType");
  if (billTypeReset) billTypeReset.value = "bill";
  const billFieldsReset = document.getElementById("captureBillFields");
  if (billFieldsReset) billFieldsReset.style.display = "none";
  document.getElementById("fileNamePreview").textContent = "";
  document.getElementById("linkUrlInput").value = "";
  ["imageCameraInput", "imageGalleryInput", "genericFileInput"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  document.getElementById("voiceDictationStatus").textContent = "";
  captureVoiceLanguage = "";
  voiceTranscript = "";
  voiceTranscriptBase = "";
  voiceLangSwapCount = 0;
  voiceCaptureBusy = false;
  voiceRecordingWasLive = false;
  stopVoiceTranscription();
  setVoiceLiveTranscript("");
  // The private reader is offered only after a specific recording comes back empty, so it starts
  // hidden on every fresh sheet rather than carrying over from the last capture.
  setVoiceLocalSttVisible(false);
  // Auto, not "whatever the browser speaks": the guess comes from this person's own captures.
  resetVoiceLangForCapture();
  renderVoiceLanguages();
  pendingBlob = null;
  pendingBlobExt = null;
  if (mediaRecorder && mediaRecorder.state === "recording")
    mediaRecorder.stop();
  /* Single one-click entry point: language is picked first (above), then this one button
     records + transcribes automatically into the capture pipeline. */
  setVoiceRecordLabel("Capture voice", "mic");
  setVoiceRecordState("idle");
  /* The caret lands in the box, as it always has — a sheet you open and cannot type into is a sheet
     you have to tap before you can use. enterDialog keeps that behaviour and adds what was missing:
     Tab stays inside the sheet, and closing it hands focus back to whatever opened it. */
  enterDialog(document.getElementById("captureModal"), "captureText");
}
function populateProjectSelect() {
  const sel = document.getElementById("captureProject");
  sel.innerHTML =
    '<option value="">No project</option>' +
    state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`,
      )
      .join("");
}
function pickType(id, manual) {
  const isChannel = ["voice", "image", "file", "link"].includes(id);
  // Picking a media chip changes the channel: how the capture is handled, and which panel is shown.
  // Picking Text resets the channel to text, so every Voice/Image-specific menu and button hides.
  // Picking any other kind only changes what the item is — the channel, any recording or picture
  // already attached, the More-types row and all field values are left exactly as they were, so
  // switching back to Text never resets the UI or collapses what was expanded.
  if (id === "text") captureChannel = "text";
  else if (isChannel) captureChannel = id;
  captureType = id;
  // Only a *kind* is a decision the reader must not undo. Choosing the Voice chip says how the
  // capture arrived, not what it is — marking it as a choice is why a dictated "call Ravi tomorrow"
  // stayed a voice note: the reader was told the kind was already settled, and stayed quiet.
  if (manual && !isChannel) captureAutoDetected = true;
  document
    .querySelectorAll(".type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.type === id));
  /* When the app files something as a kind that lives behind "More types", that row is opened. The
     person is told the decision in the same place they make one — a receipt filed as an expense
     while the chip stays hidden behind a collapsed row reads as the app deciding behind their back,
     which is the opposite of visible automation. It closes again on the next reset. */
  if (!CAPTURE_PRIMARY.includes(id) && !captureMoreTypesOpen) toggleMoreTypes();

  // The channel's own panel follows the *channel*, never the kind. A voice note that has been read
  // as a task keeps its recorder on screen, because the audio is still attached and still savable.
  const channel = captureChannel;
  document.getElementById("voiceCaptureUI").style.display =
    channel === "voice" ? "block" : "none";
  document.getElementById("imageCaptureUI").style.display =
    channel === "image" ? "block" : "none";
  document.getElementById("fileCaptureUI").style.display =
    channel === "file" ? "block" : "none";
  document.getElementById("linkCaptureUI").style.display =
    channel === "link" ? "block" : "none";
  document.getElementById("captureText").style.display = "block";
  if (channel === "voice") {
    document.getElementById("captureText").placeholder = "Type or dictate a note…";
  } else if (channel === "link") {
    document.getElementById("captureText").placeholder = "Optional note about this link…";
  } else {
    document.getElementById("captureText").placeholder = "What's on your mind?";
  }
  // The document fields follow the *kind*, the way the other panels follow the channel. A document
  // chosen while a voice note is still attached keeps the recorder, and gains these.
  const docFields = document.getElementById("captureDocFields");
  if (docFields) docFields.style.display = id === "document" ? "block" : "none";
  // Same for money. Both panels follow the kind, so a dictated expense keeps its transcript and
  // gains the amount box, and a photograph keeps its image.
  const moneyFields = document.getElementById("captureMoneyFields");
  if (moneyFields) moneyFields.style.display = id === "expense" ? "block" : "none";
  const billFields = document.getElementById("captureBillFields");
  if (billFields) billFields.style.display = id === "bill" ? "block" : "none";
  // A place belongs to the two kinds it can describe — a task with somewhere to be done, an event
  // with somewhere to happen — and also stays on screen once something has filled it, so a
  // suggestion the reader made is never hidden behind the kind it did not match.
  syncCaptureLocationField();
  // A bill repeats by default. A one-off electricity bill remembered as a bill and never repeated
  // is the failure that matters, because the next month's arrives and nothing says so.
  if (id === "bill" && manual) {
    const repeats = document.getElementById("captureRecurrence");
    if (repeats) repeats.value = "monthly";
  }
  if (manual) updateCaptureDuplicate(id, captureInputValue());
}
/* The location block follows the kind — and any value already in the box. One rule, called from
   every place that can change either, so a suggestion, a chip tap and a Clear can never leave the
   sheet showing a section its own state disagrees with. */
function syncCaptureLocationField() {
  const fields = document.getElementById("captureLocationFields");
  if (!fields) return;
  const filled = Boolean(document.getElementById("captureLocation")?.value);
  fields.style.display = ["event", "task"].includes(captureType) || filled ? "block" : "none";
}

function detectType(text) {
  const t = text.toLowerCase();
  if (
    /\b(tomorrow|today|at \d|am|pm|meeting|deadline|due|schedule)\b/.test(
      t,
    ) &&
    /\b(meeting|event|appointment|sync|demo)\b/.test(t)
  )
    return "event";
  if (
    /\b(todo|to-do|task|need to|have to|remind me|follow up|send|finish|complete|call|email)\b/.test(
      t,
    )
  )
    return "task";
  return "memory";
}
let extractDebounce = null;

function captureInputValue() {
  if (captureChannel === "link") return document.getElementById("linkUrlInput").value.trim();
  return document.getElementById("captureText").value.trim();
}

function toDateTimeLocalValue(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normaliseCaptureFingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\//g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function captureFingerprintFor(kind, title) {
  const normalized = normaliseCaptureFingerprint(title);
  return normalized ? `${kind || "text"}:${normalized}` : "";
}

const CAPTURE_GENERIC_TITLES = new Set(["file", "image", "voice note", "voice", "memory"]);

function findCaptureDuplicate(kind, title) {
  const storedKind = kind === "text" ? "memory" : kind;
  const fingerprint = captureFingerprintFor(storedKind, title);
  if (!fingerprint) return null;
  const normalizedTitle = normaliseCaptureFingerprint(title);
  if (CAPTURE_GENERIC_TITLES.has(normalizedTitle)) return null;
  const cutoff = Date.now() - 30 * 86400000;
  return state.items.find((item) => {
    if (!item || isArchived(item) || (item.created || 0) < cutoff) return false;
    if (item.scope && item.scope !== captureScope) return false;
    if (item.kind !== storedKind) return false;
    const itemFingerprint = item.captureFingerprint || captureFingerprintFor(item.kind, item.title);
    return itemFingerprint === fingerprint || normaliseCaptureFingerprint(item.title) === normalizedTitle;
  }) || null;
}

function updateCaptureDuplicate(kind, title) {
  const duplicate = findCaptureDuplicate(kind, title);
  captureDuplicate = duplicate;
  const warning = document.getElementById("captureDuplicateWarning");
  if (warning) warning.hidden = !duplicate;
  const message = document.getElementById("captureDuplicateText");
  if (message && duplicate) {
    const age = duplicate.created ? timeAgo(duplicate.created) : "recently";
    message.textContent = `“${duplicate.title}” was captured ${age}. Open it or save this as a separate item.`;
  }
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton && !saveButton.disabled) {
    if (duplicate) saveButton.textContent = "Review duplicate";
    else updateCaptureSaveLabel();
  }
  return duplicate;
}

function clearCaptureDuplicate() {
  captureDuplicate = null;
  const warning = document.getElementById("captureDuplicateWarning");
  if (warning) warning.hidden = true;
  const message = document.getElementById("captureDuplicateText");
  if (message) message.textContent = "";
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton) updateCaptureSaveLabel();
}

function openCaptureDuplicate() {
  if (!captureDuplicate) return;
  const id = captureDuplicate.id;
  closeCapture();
  openPanel(id);
}

function onCaptureSmartToggle() {
  captureSmartEnabled = Boolean(document.getElementById("captureSmartEnabled")?.checked);
  if (!captureSmartEnabled) {
    clearTimeout(extractDebounce);
    document.getElementById("captureHint").textContent = "Smart suggestions are off. You can still edit every field manually.";
    return;
  }
  if (captureInputValue()) onCaptureInput();
  else document.getElementById("captureHint").textContent = "";
}

function clearCaptureSuggestions() {
  const entries = Object.entries(captureSuggestionFields);
  entries.forEach(([field, record]) => {
    if (!record) return;
    const element = document.getElementById(record.elementId);
    if (element && element.value === record.applied) element.value = record.previous || "";
  });
  if (captureSuggestionFields.kind && captureType === captureSuggestionFields.kind.appliedKind) {
    pickType(captureSuggestionFields.kind.previous || "text", false);
    captureAutoDetected = false;
  }
  captureExtraction = null;
  captureSuggestionFields = {};
  capturePlan = [];
  captureAgenda = [];
  captureMainAsk = "";
  capturePlanTouched = false;
  // The location may have been a suggestion, so its block follows the field back to empty.
  syncCaptureLocationField();
  cancelAutoSave();
  renderCapturePlan();
  const clearButton = document.getElementById("clearCaptureSuggestionsBtn");
  if (clearButton) clearButton.disabled = true;
  dismissCaptureQuestion();
  document.getElementById("captureHint").textContent = "Suggestions cleared. Edit the fields or type again.";
}

function onLinkInput() {
  const value = document.getElementById("linkUrlInput").value.trim();
  const hint = document.getElementById("captureHint");
  if (!value) {
    if (hint) hint.textContent = "";
    clearCaptureDuplicate();
    return;
  }
  try {
    const url = new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`);
    if (hint) hint.innerHTML = `${icon("link")} Link ready: ${escapeHtml(url.hostname)}`;
  } catch (error) {
    if (hint) hint.textContent = "Enter a valid URL, for example https://example.com.";
  }
  updateCaptureDuplicate("link", value);
}

function onCaptureInput() {
  const text = document.getElementById("captureText").value;
  captureExtraction = null;
  // A stale plan belongs to words the person has since changed, so it is dropped.
  capturePlan = [];
  captureAgenda = [];
  captureMainAsk = "";
  capturePlanTouched = false;
  // Every answer given so far was an answer about the *previous* sentence. Carrying a date across
  // from words that no longer say it is how a capture ends up on the wrong day, silently.
  if (captureDialogue.answering || captureDialogue.turns.length) {
    stopCaptureAnswerDictation();
    resetCaptureDialogue();
  }
  // Same for a picture whose text has since been edited: the date that was read is no longer the
  // date on screen, so the kind is no longer known either.
  captureImageChoicePending = false;
  cancelAutoSave();
  renderCapturePlan();
  updateCaptureDuplicate(captureType, text);
  if (!captureSmartEnabled) return;
  document.getElementById("captureHint").textContent = "";
  if (!text.trim()) {
    captureAutoDetected = false;
    return;
  }

  // Typed text carries the same signal as a transcript: a Tamil sentence in the box means the next
  // recording should listen in Tamil, and an English one that it should not. In auto mode only —
  // a chip the person tapped is a decision — and silent, because this is a guess about a
  // recording that has not happened yet.
  syncDetectedCaptureLanguage(text);

  // A dictated note and a picture of text are read just like a typed sentence. A file has nothing
  // to read and a link's "text" is a URL, so neither is guessed at.
  if (!captureAutoDetected && !["file", "link"].includes(captureChannel)) {
    const guessed = detectType(text);
    if (guessed !== captureType) pickType(guessed, false);
  }

  clearTimeout(extractDebounce);
  document.getElementById("captureHint").innerHTML =
    icon("sparkles") + " Reading…";
  extractDebounce = setTimeout(() => extractWithAI(text), 700);
}

/* Smart capture, in two beats.

   First the local rules run: instant, free, offline, and good enough for a plain
   "call Ravi tomorrow". Their result is applied immediately so the sheet never feels slow.

   The model is then asked for a second opinion, but only when the rules are not confident —
   a vague time, a promise, a multi-clause sentence, or a half-read. A failure there is silent:
   the local result stands, which is why this can never block saving. */
/* Splits a capture into several items, entirely on the device, without asking the model.

   Why this exists: the plan UI, the multi-save and the single group Undo were all already built and
   all already worked — but only when the server returned several items. Offline, rate-limited, or
   simply not asked, a photo of a whiteboard with five actions on it became ONE item containing all
   five sentences. That is the worst possible outcome for a capture-first app: it looks like it
   worked, and the work is unusable.

   Deliberately conservative. Splitting prose into fragments destroys a note that was fine, and a
   receipt is many lines and exactly one item, so both are refused outright. The signal has to be
   deliberate — bullets, numbers, or an agenda line that opens with a day or a clock time — before
   anything is broken apart. Fewer items found is a much cheaper mistake than a note shredded into
   five wrong ones.

   Each line is then read by the same local extractor that already handles a whole sentence, so a
   date written on one line is understood exactly as well as a date written alone. */
const LIST_MARKER = /^\s*(?:[-*•·–—]|\d+[.)]|\(?\d+\))\s+/;
const AGENDA_OPENING = /^\s*(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\b|^\s*\d{1,2}[:.]\d{2}\b|^\s*\d{1,2}\s*(?:am|pm)\b/i;
/* Money words beside a number. Not a parser — it answers only "does this line talk about an amount",
   which is all the splitter needs to know before deciding not to break a capture apart. */
const MONEY_IN_LINE = /(?:₹|\brs\.?\b|\binr\b)\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:rupees?|lakh|crore)\b|\b(?:spent|paid|costs?|price|total|bought|charges?)\b[^.\n]{0,40}\d/i;

function splitCaptureLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const marked = lines.filter((line) => LIST_MARKER.test(line) || AGENDA_OPENING.test(line));
  /* Fewer than two explicit markers means the author was not writing a list — it is a paragraph, or
     a note whose lines merely happen to break. */
  if (marked.length < 2) return [];

  // Every line must belong. A mixed block is prose with a stray dash in it, not a list.
  if (marked.length !== lines.length) return [];

  return lines
    .map((line) => line.replace(LIST_MARKER, "").trim())
    // A stub left by a bullet with nothing after it, or an OCR artefact too short to be a thought.
    .filter((line) => line.length >= 3);
}

function localSplitItems(text, fallback) {
  const parts = splitCaptureLines(text);
  if (parts.length < 2) return null;

  /* A receipt is one thing that happens to be printed over many lines. Splitting it would turn a
     total, a date and a merchant into three unrelated items — and the receipt path already reads all
     three correctly. Refused before anything else looks at the text. */
  if (receiptTotalFromText(text)) return null;
  /* Money anywhere in the list means the lines are parts of one expense, not separate things.
     Checked per line rather than once over the whole block, and by two means rather than one: the
     shared detector needs a currency mark or a format the app itself wrote, so "spent 450 on
     groceries" read clean past it. Money words beside a number are the shape people actually type,
     and missing that is how an expense gets torn into two unrelated tasks. */
  if (parts.some((line) => parseAmountFromText(line) !== null || MONEY_IN_LINE.test(line))) {
    return null;
  }

  const parts2 = parts.map((line) => {
    const read = extractLocally(line);
    return {
      ...fallback,
      ...read,
      title: line,
      // A date on the whole capture but not on this line is a header — "before Friday:" over a
      // list — so the line inherits it. A line that names its own date keeps it.
      dueDate: read.dueDate || fallback?.dueDate || "",
    };
  });
  return parts2;
}

async function extractWithAI(text) {
  const local = extractLocally(text);
  if (document.getElementById("captureText").value !== text) return;
  applyExtraction(local, text);

  if (!captureSmartEnabled) return;
  if (!captureNeedsModelHelp(text, local)) return;

  setCaptureHint(icon("sparkles") + " Reading more carefully…");
  const ai = await requestModelExtraction(text);
  // The person kept typing while the request was in flight; the answer is now stale.
  if (document.getElementById("captureText").value !== text) return;
  if (ai) applyExtraction(mergeExtractions(local, ai), text);
  // After the form settles, so the plan and the fields cannot disagree on the main item.
  if (ai) setCapturePlan(ai.items, ai.ambiguous);
  /* What this reading produced, kept so a conversation that finishes later can create exactly these
     items without the model being asked a second time. The local rules only ever describe the one
     entry the form is editing, so they stand in as a single-entry plan — the same shape the server
     returns, so finishCaptureDialogue() does not have to know which path ran. */
  const localParts = localSplitItems(text, local);
  captureLastPlan = (ai?.items?.length ? ai.items : localParts || [local])
    .map((entry) => (entry && typeof entry === "object" ? { ...entry, title: entry.title || text } : null))
    .filter((entry) => entry && String(entry.title || "").trim());
  captureLastText = text;
  // "Done." A sentence that read cleanly creates itself; an unclear one still asks.
  if (ai?.items?.length) scheduleAutoSave(ai.items, text);
  /* A list found on the device saves the same way an AI-provided one does, and is previewed the same
     way, because both go through captureLastPlan and setCapturePlan. Nothing about the preview, the
     save or the Undo knows or cares which of the two produced the entries. */
  else if (localParts) setCapturePlan(localParts, []);
}

function renderCapturePlan() {
  const host = document.getElementById("capturePlan");
  if (!host) return;
  if (!capturePlan.length && !captureAgenda.length && !captureMainAsk) {
    host.hidden = true;
    host.innerHTML = "";
    updateCaptureSaveLabel();
    return;
  }
  host.hidden = false;
  // The main item's own question belongs here, because the form has nowhere to show it.
  const askLine = captureMainAsk
    ? `<p class="capture-plan-ask">${icon("circle-help")} ${escapeHtml(captureMainAsk)}</p>`
    : "";
  const agendaLine = captureAgenda.length
    ? `<p class="capture-plan-agenda">${icon("list-checks")} Also added to the first item, as steps: ${escapeHtml(
        captureAgenda.map((entry) => entry.title).join(", "),
      )}</p>`
    : "";
  const headLine = capturePlan.length
    ? `<p class="capture-plan-head">${icon("layers")} This sentence holds ${
        capturePlan.length + 1
      } things. They are all saved.</p>`
    : "";
  host.innerHTML = [
    headLine,
    askLine,
    agendaLine,
    capturePlan.map((entry, index) => capturePlanRowHtml(entry, index)).join(""),
  ].join("");
  refreshIcons();
  updateCaptureSaveLabel();
}

function capturePlanRowHtml(entry, index) {
  const flag = entry.ambiguous
    ? `<p class="capture-plan-flag">${icon("circle-help")} ${escapeHtml(entry.ambiguous)}</p>`
    : "";
  const options = CAPTURE_PLAN_KINDS.map(
    (kind) =>
      `<option value="${kind}"${kind === entry.kind ? " selected" : ""}>${escapeHtml(
        CAPTURE_PLAN_KIND_LABELS[kind],
      )}</option>`,
  ).join("");
  return `<div class="capture-plan-row" data-plan-index="${index}">
            <div class="capture-plan-row-top">
              <input class="capture-plan-title" type="text" value="${escapeHtml(entry.title)}"
                oninput="editCapturePlan(${index}, 'title', this.value)"
                aria-label="Item ${index + 1} title" />
              <button type="button" class="capture-plan-remove" onclick="removeCapturePlan(${index})"
                aria-label="Remove item ${index + 1}">${icon("x")}</button>
            </div>
            <div class="capture-plan-row-bottom">
              <select class="capture-plan-select" onchange="editCapturePlan(${index}, 'kind', this.value)"
                aria-label="Item ${index + 1} type">${options}</select>
              <input class="capture-plan-due" type="datetime-local"
                value="${escapeHtml(toDateTimeLocalValue(entry.dueDate))}"
                onchange="editCapturePlan(${index}, 'dueDate', this.value)"
                aria-label="Item ${index + 1} due" />
            </div>
            ${flag}
          </div>`;
}

/* ---------- Undo for an auto-created capture ----------

   Auto-create is silent, so it is only acceptable if it is cheap to reverse. This bar names
   what was created and removes the whole group, because a capture that made three items must be
   undoable as the one action the person took, not three. */
let captureUndoTimer = null;
let captureUndoItems = [];
/* The generic undo bar's action, held alongside the capture flow's own state. Both write to the
   same bar, so the pending action has to be cleared on dismiss — otherwise a later dismiss would
   fire an undo belonging to an action that already finished. */
let pendingUndoAction = null;

function showCaptureUndo(items) {
  const bar = document.getElementById("captureUndo");
  if (!bar) return;
  captureUndoItems = items;
  clearTimeout(captureUndoTimer);
  const count = items.length;
  bar.innerHTML = `${icon("check")} <span>${escapeHtml(
    count === 1 ? items[0].title : `Saved ${count} items`,
  )}</span> <button type="button" class="capture-undo-btn" onclick="undoCaptureSave()">Undo</button>`;
  bar.hidden = false;
  refreshIcons();
  captureUndoTimer = setTimeout(dismissCaptureUndo, 8000);
}

function dismissCaptureUndo() {
  clearTimeout(captureUndoTimer);
  captureUndoTimer = null;
  captureUndoItems = [];
  pendingUndoAction = null;
  const bar = document.getElementById("captureUndo");
  if (bar) {
    bar.hidden = true;
    bar.innerHTML = "";
  }
}

async function undoCaptureSave() {
  const items = captureUndoItems;
  dismissCaptureUndo();
  // Main item first, so no extra is ever orphaned pointing at a row that is already gone.
  for (const item of items.slice().reverse()) {
    state.items = state.items.filter((i) => i.id !== item.id);
    await dbDeleteItem(item.id, item);
  }
  renderAll();
}

/* Extra plan rows as real items, linked back via planOf so the group stays traceable. */
/* The status a captured task starts in follows the date it was given, not the fact that it was typed
   today. Hardcoding "today" put every captured task in the Today list whatever its due date, so a
   note for next week read as work for this afternoon, and the person trusted the list rather than
   the date they had just written. Only a task actually due today belongs there; everything else is
   Planned until they move it. This is the same rule model.js and recurring.js already apply. */
function captureTaskStatus(dueISO) {
  if (!dueISO) return "planned";
  const d = new Date(dueISO);
  if (Number.isNaN(d.getTime())) return "planned";
  return d.toDateString() === new Date().toDateString() ? "today" : "planned";
}

function buildCapturePlanItems(main) {
  return capturePlan
    .map((entry, index) => {
      const title = String(entry.title || "").trim();
      if (!title) return null;
      const parsed = entry.dueDate ? new Date(entry.dueDate) : null;
      const dueISO = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
      return {
        id: cid(),
        ownerId: main.ownerId,
        kind: entry.kind,
        title,
        sub: CAPTURE_PLAN_SUB[entry.kind] || "Captured task",
        priority: entry.priority || (entry.kind === "task" ? "medium" : ""),
        person: entry.person || "",
        location: entry.location || "",
        due: dueISO ? formatDueDisplay(dueISO) : "",
        dueDate: dueISO,
        recurrence: "none",
        status: entry.kind === "task" ? captureTaskStatus(dueISO) : "inbox",
        project: entry.project || main.project,
        created: Date.now(),
        done: false,
        scope: main.scope,
        mediaUrl: "",
        sourceType: main.sourceType,
        rawText: main.rawText,
        captureMetadata: { ...main.captureMetadata, planOf: main.id, planIndex: index + 2 },
        captureFingerprint: CAPTURE_GENERIC_TITLES.has(normaliseCaptureFingerprint(title))
          ? null
          : captureFingerprintFor(entry.kind, title),
      };
    })
    .filter(Boolean);
}

/* Progress line under the smart-suggestions toggle. Extracted so the reading steps can never
   overwrite each other out of order. */
function setCaptureHint(html) {
  const hint = document.getElementById("captureHint");
  if (hint) hint.innerHTML = html || "";
}
function applyExtraction(data, text) {
  data = data && typeof data === "object" ? data : {};
  const previousKind = captureType;
  if (
    data.kind &&
    !captureAutoDetected &&
    // The model's reading applies to a dictated note and a picture of text too — that is the whole
    // point. Only a file and a link are left as they are.
    !["file", "link"].includes(captureChannel) &&
    data.kind !== captureType
  ) {
    captureSuggestionFields.kind = { appliedKind: data.kind, previous: previousKind };
    pickType(data.kind, false);
  }

  const applyField = (id, value) => {
    if (value === undefined || value === null || value === "") return;
    const element = document.getElementById(id);
    if (!element || element.value) return;
    const previous = element.value;
    element.value = value;
    captureSuggestionFields[id] = { elementId: id, previous, applied: value };
  };

  applyField("capturePriority", data.priority);
  applyField("captureDueDate", toDateTimeLocalValue(data.dueDate));
  applyField("capturePerson", data.person);
  // A place is filled in exactly like every other suggestion: only when the field is empty, so a
  // value the person already typed is never overwritten.
  applyField("captureLocation", data.location);
  syncCaptureLocationField();
  applyField("captureRecurrence", data.recurrence !== "none" ? data.recurrence : "");
  // ---------- Intelligent auto-fill: the kind's own boxes ----------
  // An expense or bill read from the sentence fills its own Amount box in plain rupees (the save
  // path converts to paise), so the number is visible and checkable before saving. A typed value
  // always wins: applyField skips a box the person already touched.
  applyField("captureAmount", data.amount);
  applyField("captureBillAmount", data.amount);
  applyField("captureMerchant", data.merchant);
  applyField("captureBillMerchant", data.billMerchant || data.merchant);
  applyField("captureSpentOn", data.spentOn);
  applyField("captureBillDue", data.billDue);
  if (data.category && !document.getElementById("captureCategory").value) {
    const categorySelect = document.getElementById("captureCategory");
    const match = [...categorySelect.options].find((option) => option.value === data.category);
    if (match) {
      const previous = categorySelect.value;
      categorySelect.value = data.category;
      captureSuggestionFields.captureCategory = { elementId: "captureCategory", previous, applied: data.category };
    }
  }
  if (data.billType && !document.getElementById("captureBillType").value) {
    const typeField = document.getElementById("captureBillType");
    const previous = typeField.value;
    typeField.value = data.billType;
    captureSuggestionFields.captureBillType = { elementId: "captureBillType", previous, applied: data.billType };
  }
  // A document's drawer and paper trail. The expiry moves into the doc box; the generic due box is
  // left for the doc-answer path below to clear, so "Clear suggestions" can restore it.
  applyField("captureDocType", data.docType);
  applyField("captureDocIssuer", data.docIssuer);
  applyField("captureDocNumber", data.docNumber);
  if (data.docExpires) {
    const expiryField = document.getElementById("captureDocExpires");
    if (expiryField && !expiryField.value) {
      const previous = expiryField.value;
      expiryField.value = data.docExpires;
      captureSuggestionFields.captureDocExpires = { elementId: "captureDocExpires", previous, applied: data.docExpires };
      captureDocExpiry = data.docExpires;
    }
  }
  if (data.project && !document.getElementById("captureProject").value) {
    const projectSelect = document.getElementById("captureProject");
    const match = [...projectSelect.options].find((option) => option.value === data.project);
    if (match) {
      const previous = projectSelect.value;
      projectSelect.value = data.project;
      captureSuggestionFields.captureProject = { elementId: "captureProject", previous, applied: data.project };
    }
  }

  captureExtraction = {
    ...data,
    source: "smart-capture",
    appliedKind: previousKind,
  };
  const parts = [];
  if (data.kind) parts.push(data.kind);
  if (data.dueDate) parts.push("due " + formatDueDisplay(data.dueDate));
  if (data.person) parts.push("person: " + data.person);
  if (data.location) parts.push("at " + data.location);
  if (data.priority) parts.push(data.priority + " priority");
  if (data.recurrence && data.recurrence !== "none") parts.push(data.recurrence);
  const clearButton = document.getElementById("clearCaptureSuggestionsBtn");
  if (clearButton) clearButton.disabled = parts.length === 0;
  // Say when the model was involved, so a better reading is visibly better rather than magic.
  const byline = data.aiUsed ? " (read by AI)" : "";
  setCaptureHint(
    parts.length
      ? `${icon("sparkles")} Suggestions${byline}: ${escapeHtml(parts.join(", "))} — edit any field to override.`
      : "",
  );
  renderCaptureQuestions(text, data);
  const currentText = captureInputValue();
  if (currentText) updateCaptureDuplicate(captureType, currentText);
}

/* ---------- Missing-value questions ----------
   The product rule from the spec: the assistant must not invent what an uncertain phrase means.
   "Maybe Friday" is not a date, so instead of silently guessing it, the sheet asks.

   Deliberately restrained. It asks at most one question at a time, only for the two cases that
   genuinely change what gets saved (an unreliable date, a promise that needs following up), and
   it never blocks saving — every question can be ignored. "Suggestions, not pressure." */
function renderCaptureQuestions(text, data) {
  const card = document.getElementById("captureQuestion");
  if (!card) return;
  const questions = buildCaptureQuestions(text, data || {});

  // A value the app will not invent is asked for in the person's own words. This has to happen
  // before the "no questions at all" bail-out below, because a sentence that only needs a date
  // produces no fixed questions — and that is precisely the case the conversation exists for.
  //
  // The conversation also outranks a fixed yes/no. "Remind me to call Arun" is not in doubt about
  // being a task, it is in doubt about when, and a question about the kind would sit in front of
  // the one that matters.
  if (!captureDialogue.answering && !captureDialogue.turns.length) {
    const slots = requiredCaptureSlots(text, data || {});
    if (slots.length) captureDialogue.required = slots;
  }
  if (captureDialogue.required.length) {
    // Only rebuild when the value being asked for has actually changed. A second reading of the
    // same sentence — which arrives whenever the model is consulted a moment later — must not wipe
    // an answer that is already being typed, nor steal the caret out from under it.
    if (captureDialogue.shownSlot && captureDialogue.shownSlot === captureDialogue.required[0]) {
      captureQuestions = questions;
      return;
    }
    captureQuestions = questions;
    advanceCaptureDialogue();
    return;
  }

  if (!questions.length) {
    card.hidden = true;
    card.innerHTML = "";
    captureQuestions = [];
    return;
  }
  captureQuestions = questions;
  renderCaptureQuestion();
}

function buildCaptureQuestions(text, data) {
  const body = String(text || "");
  const questions = [];

  // A picture that carries a date. Photographed appointment cards, tickets and invitations all
  // land here, and a date on its own does not say what the thing *is* — an event, something to be
  // reminded of, or just a record worth keeping. That is the one decision a picture cannot settle
  // by reading it, so it is offered rather than guessed.
  if (captureChannel === "image" && imageOcrText && (data.dueDate || textLooksLikeReceipt(imageOcrText))) {
    // Set here rather than where the card renders, because this is the moment the app knows it is
    // in doubt, and the auto-create gate has to see it from that moment on.
    captureImageChoicePending = true;
    // A photographed warranty, insurance policy or licence is the fourth thing a date-bearing
    // picture can be, and filing one as a task loses the only field that mattered — the expiry.
    // Offered only when the text actually reads like a document, so an appointment card is not
    // asked a question about documents it has nothing to do with.
    const options = [
      { label: "Create event", value: "event" },
      { label: "Set reminder", value: "reminder" },
      { label: "Save as note", value: "note" },
    ];
    if (textLooksLikeDocument(imageOcrText)) {
      options.push({ label: "Keep as document", value: "document" });
    }
    // A photographed receipt is the strongest case for a fourth answer: the total is printed on the
    // paper, so there is nothing to decide — only a number to check. The amount is filled in and left
    // visible for editing, never saved straight from the read.
    if (textLooksLikeReceipt(imageOcrText)) {
      options.push({ label: "Record as expense", value: "expense" });
    }
    // A receipt with no readable date still has to reach the card, and asking it about a date it
    // never found would be nonsense. So the wording follows what was actually on the paper.
    const total = receiptTotalFromText(imageOcrText);
    const headline = data.dueDate
      ? `I found a date on ${escapeHtml(formatDueDisplay(data.dueDate))}: ${escapeHtml(
          String(data.title || body).trim().slice(0, 80) || "an appointment",
        )}.`
      : total
        ? `This looks like a receipt. I read ${escapeHtml(formatMoney(total.amountMinor))} as the total.`
        : "This looks like a receipt.";
    questions.push({
      id: "image-choice",
      question: `${headline} What would you like me to do?`,
      options,
    });
  }

  // An expense, or a bill. "Spent ₹450 for groceries" is history and "pay ₹899 for internet on the
  // 10th" is a future obligation, and the difference is a date. Only a settled kind is switched
  // here: with no amount, or no spend wording, the app is not sure and must ask rather than file
  // someone's electricity bill as a note.
  const amountMinor = parseAmountFromText(body);
  if (!questions.length && amountMinor !== null && amountMinor > 0 && textLooksLikeExpense(body)) {
    const wanted = textLooksLikeBill(body) ? "bill" : "expense";
    if (!captureAutoDetected && !["file", "link"].includes(captureChannel) && captureType === "text") {
      captureSuggestionFields.kind = { appliedKind: wanted, previous: captureType };
      pickType(wanted, false);
      // A bill that names a service is a subscription, and the two live in different lists with
      // different totals. The guess is written into the picker rather than used behind the person's
      // back, so it is visible and can be changed.
      if (wanted === "bill") {
        const typeField = document.getElementById("captureBillType");
        const guessed = guessBillType(body);
        if (typeField && guessed) typeField.value = guessed;
      }
    }
  }

  // A promise the person made. Worth one tap: a reminder for it is the difference between
  // keeping a commitment and quietly missing it.
  //
  // Not asked when the sentence already says "remind me to". There the intent is not in doubt, and
  // a yes/no about it would sit in front of the conversation that actually settles the reminder —
  // three taps to reach a question the person had already answered by speaking.
  if (COMMITMENT_RE.test(body) && !REMINDER_INTENT_RE.test(body)) {
    questions.push({
      id: "commitment",
      question: "This sounds like something you promised. Shall I keep it as a task?",
      options: [
        { label: "Yes, make it a task", value: "task" },
        { label: "Save as a note", value: "note" },
      ],
    });
  }

  // ---------- Intelligent auto-fill follow-ups: ask gently for what is still missing ----------
  // Every question here is non-blocking and dismissible — the sheet saves fine without an answer.
  // One at a time (the card only ever shows questions[0]), most blocking first: an expense without
  // an amount cannot be saved at all, so it is asked before anything merely nice to have.
  const kind = data.kind || captureType;
  const hasAmount =
    document.getElementById("captureAmount")?.value ||
    document.getElementById("captureBillAmount")?.value ||
    (amountMinor !== null && amountMinor > 0);
  if (!questions.length && (kind === "expense" || kind === "bill") && !hasAmount) {
    questions.push({
      id: "missing-amount",
      question:
        kind === "expense"
          ? "How much did you spend? I could not find an amount in that."
          : "What is the bill amount? I could not find a number in that.",
      options: [
        { label: "Type the amount", value: "type-amount" },
        { label: "No amount", value: "no-amount" },
      ],
    });
  }
  if (
    !questions.length &&
    kind === "bill" &&
    !document.getElementById("captureBillDue")?.value &&
    !data.dueDate &&
    !data.billDue
  ) {
    questions.push({
      id: "missing-bill-due",
      question: "When is this bill due? A day keeps it reminding you on time.",
      options: [
        { label: "Pick the day", value: "pick-bill-due" },
        { label: "No due date", value: "no-bill-due" },
      ],
    });
  }
  if (
    !questions.length &&
    kind === "document" &&
    !document.getElementById("captureDocExpires")?.value &&
    !data.docExpires
  ) {
    questions.push({
      id: "missing-doc-expiry",
      question: "When does this document expire? I can remind you before it does.",
      options: [
        { label: "Pick the date", value: "pick-doc-expiry" },
        { label: "No expiry", value: "no-doc-expiry" },
      ],
    });
  }
  if (
    !questions.length &&
    (kind === "task" || kind === "event") &&
    !data.person &&
    /\b(call|meet|remind|tell|ask|send|email|message|wish)\b/i.test(body)
  ) {
    questions.push({
      id: "missing-person",
      question: "Who is this about? A name keeps it linked to the right person.",
      options: [
        { label: "Type the name", value: "type-person" },
        { label: "Nobody in particular", value: "no-person" },
      ],
    });
  }

  // A time the wording does not actually pin down.
  const vague = body.match(VAGUE_TIME_RE);
  if (vague && (data.dueDate || /\b(friday|monday|tuesday|wednesday|thursday|saturday|sunday|week|month)\b/i.test(body))) {
    questions.push({
      id: "vague-date",
      question: data.dueDate
        ? `I read "${escapeHtml(vague[0])}" as ${escapeHtml(formatDueDisplay(data.dueDate))}. Keep that, or pick another day?`
        : `"${escapeHtml(vague[0])}" is not a specific day. Add one?`,
      options: data.dueDate
        ? [
            { label: "Keep it", value: "keep" },
            { label: "Pick another day", value: "pick" },
            { label: "No date", value: "clear" },
          ]
        : [
            { label: "Pick a day", value: "pick" },
            { label: "No date", value: "clear" },
          ],
    });
  }

  return questions;
}

/* Shows one question at a time so the sheet never turns into a form to fill in. A slot question
   also gets a free-text field and a mic, because the whole point is to answer in your own words
   rather than open a date picker. */
function renderCaptureQuestion() {
  const card = document.getElementById("captureQuestion");
  if (!card) return;
  const question = captureQuestions[0];
  if (!question) {
    card.hidden = true;
    card.innerHTML = "";
    return;
  }
  card.hidden = false;
  // A slot question is a continuation of the sentence, not a separate dialog: it sits flush under
  // the box with no card of its own, because the answer is going back into that box as words.
  card.classList.toggle("slot", Boolean(question.slot));
  // A slot question has no fixed answers, so it renders the field and nothing else.
  const actions = question.slot
    ? ""
    : `<div class="capture-question-actions">
        ${question.options
          .map(
            (option) =>
              `<button type="button" class="btn" onclick="answerCaptureQuestion(${jsStr(
                option.value,
              )})">${escapeHtml(option.label)}</button>`,
          )
          .join("")}
        <button type="button" class="capture-question-skip" onclick="dismissCaptureQuestion()">Dismiss</button>
      </div>`;
  // A slot question leads with the common answers as chips, because the ordinary case is one tap.
  // "Other…" is what reveals the free-text field, and the mic sits beside it — the sheet is not
  // dominated by an input box that most captures never need.
  const reply = question.slot
    ? `<div class="capture-question-reply">
        <div class="capture-question-chips">
          ${(question.chips || [])
            .map(
              (label) =>
                `<button type="button" class="capture-chip" onclick="answerCaptureQuestion(${jsStr(
                  question.slot + ":" + label,
                )})">${escapeHtml(label)}</button>`,
            )
            .join("")}
          <button
            type="button"
            class="capture-chip other ${captureAnswerOpen ? "open" : ""}"
            onclick="toggleCaptureAnswerField()"
          >Other…</button>
        </div>
        ${
          captureAnswerOpen
            ? `<div class="capture-answer-open">
                <input
                  id="captureQuestionInput"
                  class="capture-question-input"
                  type="text"
                  inputmode="text"
                  autocomplete="off"
                  placeholder="${escapeHtml(question.placeholder || "")}"
                  aria-label="${escapeHtml(question.question)}"
                  onkeydown="if (event.key === 'Enter') { event.preventDefault(); submitCaptureAnswer(); }"
                />
                <button type="button" class="btn capture-question-send" onclick="submitCaptureAnswer()">Send</button>
                <button
                  type="button"
                  id="captureQuestionMic"
                  class="capture-question-mic"
                  onclick="toggleCaptureAnswerDictation()"
                  aria-label="Say the answer"
                  title="Say the answer"
                >${icon("mic")}</button>
              </div>`
            : ""
        }
        <button type="button" class="capture-question-skip" onclick="dismissCaptureQuestion()">Dismiss</button>
        <p class="capture-question-status" id="captureQuestionStatus" role="status"></p>
      </div>`
    : "";
  card.innerHTML = `<p class="capture-question-text">${question.question}</p>
    ${reply}
    ${actions}`;
  // Once a question is on screen it has taken over from the progress line, and "Reading more
  // carefully…" sitting under it reads as though something is still happening.
  if (question.slot) {
    const hint = document.getElementById("captureHint");
    if (hint) hint.textContent = "";
  }
  refreshIcons();
}

function dismissCaptureQuestion() {
  captureQuestions = [];
  // Dismissing ends the conversation rather than leaving it half-asked. This is the promise the
  // question card has always made — it can be ignored and never blocks a save — so a conversation
  // must not become the one thing in the sheet that cannot be waved away.
  captureImageChoicePending = false;
  stopCaptureAnswerDictation();
  captureDialogue.answering = false;
  captureDialogue.required = [];
  const card = document.getElementById("captureQuestion");
  if (card) {
    card.hidden = true;
    card.innerHTML = "";
  }
}

/* Applies an answer. A choice the person makes is no longer a suggestion, so it is recorded as
   an empty entry in captureSuggestionFields — "Clear suggestions" must not undo a decision. */
function answerCaptureQuestion(value) {
  const question = captureQuestions[0];
  if (!question) return;

  // A chip carries "slot:phrase" and takes the same road as a typed answer, so "Tomorrow" tapped
  // and "Tomorrow" typed are the same code path and cannot drift apart.
  const chip = String(value).match(/^([a-zA-Z]+):(.+)$/);
  if (chip && chip[1] === question.slot) {
    captureAnswerOpen = false;
    return answerSlot(question, chip[2]);
  }

  // A picture that carried a date, and nothing is being asked about it any more. The auto-create
  // has to wait for this answer: a photographed appointment card is exactly the case where a
  // silent wrong guess is worst, because the person never asked for one.
  if (question.id === "image-choice") {
    captureImageChoicePending = false;
    // Never override a kind the person chose themselves.
    if (!captureAutoDetected && !["file", "link"].includes(captureChannel)) {
      const wanted =
        value === "event"
          ? "event"
          : value === "note"
            ? "memory"
            : value === "document"
              ? "document"
              : value === "expense"
                ? "expense"
                : "task";
      if (wanted !== captureType) {
        captureSuggestionFields.kind = { appliedKind: wanted, previous: captureType };
        pickType(wanted, false);
      }
    }
    // A reminder is a task with a time on it, and the date the picture carried is the reminder.
    if (value === "reminder") {
      const field = document.getElementById("captureDueDate");
      if (field?.value) captureSuggestionFields.captureDueDate = null;
    }
    // A document is not *due* on its expiry, it *expires* on it. The date that was read has to move
    // out of the due field and into the expiry field, or it would both nag as a task due today and
    // leave the expiry — the only field a document has — empty. Nothing is cleared from the due
    // field, so "Clear suggestions" can still put it back the way it was found.
    if (value === "document") {
      const field = document.getElementById("captureDueDate");
      const read = field?.value ? field.value.slice(0, 10) : "";
      if (read) {
        captureDocExpiry = read;
        const expiryField = document.getElementById("captureDocExpires");
        if (expiryField) expiryField.value = read;
        if (field.value) captureSuggestionFields.captureDueDate = null;
      }
      if (!captureType || captureType === "text") {
        captureSuggestionFields.kind = { appliedKind: "document", previous: captureType };
        pickType("document", false);
      }
    }
    // A receipt answers its own amount. The total, the shop and the date are all printed on the
    // paper, so the boxes are filled from the read and left in plain sight — the person checks the
    // number rather than being told it. Nothing is saved from here directly.
    if (value === "expense" && captureChannel === "image" && imageOcrText) {
      const total = receiptTotalFromText(imageOcrText);
      const amountField = document.getElementById("captureAmount");
      // Filled with plain rupees, not the paise integer: this is the one place a person reads it,
      // and "450" is what is on the paper. parseMoneyToMinor does the conversion on save.
      if (total && amountField && !amountField.value) {
        amountField.value = String(Math.floor(total.amountMinor / PAISE_PER_RUPEE));
        captureSuggestionFields.captureAmount = { applied: amountField.value, previous: "" };
      }
      const spentField = document.getElementById("captureSpentOn");
      const printed = receiptDateFromText(imageOcrText);
      if (printed && spentField && !spentField.value) spentField.value = printed;
      const merchantField = document.getElementById("captureMerchant");
      const shop = receiptMerchantFromText(imageOcrText);
      if (shop && merchantField && !merchantField.value) merchantField.value = shop;
      const categoryField = document.getElementById("captureCategory");
      const category = guessMoneyCategory(imageOcrText);
      if (category && categoryField && !categoryField.value) categoryField.value = category;
      const receiptHint = document.getElementById("captureHint");
      if (receiptHint && total) {
        receiptHint.textContent = `Read ${formatMoney(total.amountMinor)} from "${total.line}". Check it, then save.`;
      }
    }
  }

  if (question.id === "commitment") {
    if (value === "task") {
      // Never override a type the person chose themselves. A dictated "I'll send the proposal" is
      // a commitment, and being asked to confirm it is the whole point of the question.
      if (!captureAutoDetected && !["file", "link"].includes(captureChannel)) {
        captureSuggestionFields.kind = { appliedKind: "task", previous: captureType };
        pickType("task", false);
      }
    }
  }

  if (question.id === "vague-date") {
    const field = document.getElementById("captureDueDate");
    if (value === "clear") {
      if (field) field.value = "";
      captureSuggestionFields.captureDueDate = null;
    } else if (value === "pick") {
      field?.focus();
      field?.showPicker?.();
    } else {
      // "Keep it" — protect the existing suggestion from being cleared.
      if (field?.value) captureSuggestionFields.captureDueDate = null;
    }
  }

  // ---------- Intelligent auto-fill answers: gentle follow-ups land in the right box ----------
  // None of these blocks saving or invents a value. "Type…" focuses the box so the person can say
  // or type it; "No…" dismisses gracefully and leaves the field empty — an honest empty beats a
  // guessed one. A focused box is a decision, so "Clear suggestions" must not undo the value typed
  // there afterwards (the null-entry rule answerCaptureQuestion already follows).
  if (question.id === "missing-amount") {
    if (value === "type-amount") {
      const field =
        document.getElementById(captureType === "bill" ? "captureBillAmount" : "captureAmount") ||
        document.getElementById("captureAmount") ||
        document.getElementById("captureBillAmount");
      field?.focus();
      if (field) captureSuggestionFields[field.id] = null;
      setCaptureHint(`${icon("circle-help")} Tell me the amount — type it into the Amount box.`);
      return;
    }
  }
  if (question.id === "missing-bill-due") {
    if (value === "pick-bill-due") {
      const field = document.getElementById("captureBillDue");
      field?.focus();
      field?.showPicker?.();
      if (field) captureSuggestionFields.captureBillDue = null;
      return;
    }
  }
  if (question.id === "missing-doc-expiry") {
    if (value === "pick-doc-expiry") {
      const field = document.getElementById("captureDocExpires");
      field?.focus();
      field?.showPicker?.();
      if (field) captureSuggestionFields.captureDocExpires = null;
      return;
    }
  }
  if (question.id === "missing-person") {
    if (value === "type-person") {
      const field = document.getElementById("capturePerson");
      field?.focus();
      if (field) captureSuggestionFields.capturePerson = null;
      setCaptureHint(`${icon("circle-help")} Tell me who — type the name into the Person box.`);
      return;
    }
  }

  captureQuestions.shift();
  renderCaptureQuestion();
  const currentText = captureInputValue();
  if (currentText) updateCaptureDuplicate(captureType, currentText);
}

/* ---------- Conversation engine ----------

   The question card above can only offer fixed buttons, so "Remind me to call Arun" could ask
   whether to keep it but never *when*. The only answer available was the native date picker,
   which is the form this is meant to remove.

   This turns that card into a short conversation. A slot is a value the app refuses to invent —
   the same rule VAGUE_TIME_RE already encodes, applied to the whole capture rather than to one
   phrase. The person supplies it in their own words, typed or spoken, and it is resolved against
   the parsers that already exist in this file.

   Every limit of the question card is kept deliberately:
     - one question at a time
     - always dismissible, so nothing here can block a save
     - an answer that resolves to nothing is never guessed at; it is asked again
     - the original buttons stay, as the route for someone who would rather tap than type     */
const CAPTURE_SLOT_QUESTIONS = {
  dueDate: {
    question: "Sure. What date?",
    placeholder: "Tomorrow",
    // The common answers, so the ordinary case is one tap. A chip carries a phrase that the
    // existing parsers already read, so nothing here needs its own date reader.
    chips: ["Tomorrow", "Tonight", "Tomorrow morning", "This weekend", "Next week"],
  },
  dueTime: {
    question: "What time?",
    placeholder: "10 AM",
    chips: ["9 AM", "10 AM", "12 PM", "5 PM", "6 PM"],
  },
};

/* A clock time on its own — "10 AM", "at 4:30". parseLocalDate() deliberately answers null
   without a date word, so the two halves of "tomorrow at 4" have to be read separately rather
   than by one parser that would have to guess which half was meant. */
function parseLocalTimeOnly(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const match =
    t.match(/\b(?:at\s+)?(\d{1,2})(?::|.)(\d{2})\s*(am|pm)\b/) ||
    t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ||
    t.match(/\bat\s+(\d{1,2})[:.](\d{2})\b/) ||
    t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  if (hours > 23 || minutes > 59) return null;
  if (match[3] === "pm" && hours < 12) hours += 12;
  if (match[3] === "am" && hours === 12) hours = 0;
  // A lone "10" with neither a colon nor am/pm is far more often a quantity than an hour, so it
  // is left alone rather than read as midnight.
  if (!match[3] && !t.includes(":") && !t.includes(".")) return null;
  return { hours, minutes };
}

/* Did this value carry a real clock time, or is it a bare day parked at midnight?
   toDateTimeLocalValue writes 00:00 for "tomorrow", and a day with no time must still be asked
   for one. */
function hasExplicitClock(value) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
}

/* Words that mean the sentence is asking to be reminded of something, rather than simply
   recording it. This is the whole trigger for the conversation: only a sentence like this is
   genuinely incomplete without a day, because a task with no date is still a perfectly good task. */
const REMINDER_INTENT_RE =
  /\b(remind me|remind us|reminder|remember to|don'?t forget|do not forget|ping me|notify me|alarm)\b/i;

/* Which values this sentence still needs before it can become an item. Deliberately narrow.
   Anything outside it has always been allowed to save as it stands, and a capture that used to
   save itself silently must not start stopping to ask — otherwise this feature would quietly
   break every clear sentence the app already handled on its own. */
function requiredCaptureSlots(text, data) {
  const body = String(text || "");
  if (!REMINDER_INTENT_RE.test(body)) return [];
  const due = data?.dueDate || document.getElementById("captureDueDate")?.value || "";
  // A reminder with no day is not a reminder yet.
  if (!due) return ["dueDate"];
  // A reminder with a day but no hour is still a reminder, so the clock time is asked for as a
  // convenience, not as a blocker.
  if (!hasExplicitClock(due)) return ["dueTime"];
  return [];
}

/* Resolves one typed or spoken answer and writes it into the field the item is saved from.
   Returns what it understood, or null when the words do not actually carry the value — the
   caller asks again rather than inventing one. */
function applyCaptureSlot(slot, answer) {
  const words = String(answer || "").trim();
  if (!words) return null;
  const field = document.getElementById("captureDueDate");
  if (!field) return null;

  const time = parseLocalTimeOnly(words);
  let when = null;

  if (slot === "dueTime") {
    if (!time) return null;
    // A clock time is set onto whichever day is already chosen. With no day yet there is nothing
    // to attach it to, so the date question has to come first.
    const base = field.value ? DATE_TIME.toDate(DATE_TIME.fromDateTimeLocal(field.value)) : null;
    if (!base || Number.isNaN(base.getTime())) return null;
    base.setHours(time.hours, time.minutes, 0, 0);
    // "10 AM" said for a morning that has already gone means the next one.
    if (base.getTime() <= Date.now()) base.setDate(base.getDate() + 1);
    when = base;
  } else {
    const parsed = parseLocalDate(words);
    if (!parsed) return null;
    // "4 pm" carries an hour as well as a day, and answering both at once must not ask twice.
    if (time) parsed.setHours(time.hours, time.minutes, 0, 0);
    when = parsed;
  }

  const iso = when.toISOString();
  field.value = toDateTimeLocalValue(iso);
  // A value the person gave is a decision, not a suggestion, so "Clear suggestions" must not
  // take it away. This is the same rule answerCaptureQuestion() already follows.
  captureSuggestionFields.captureDueDate = null;
  captureDialogue.filled[slot] = iso;
  // Whether the answer actually carried a clock time. parseLocalDate() invents a 9am when none was
  // said, so the ISO alone cannot answer this — the words can.
  return { iso, said: formatDueDisplay(iso), hadTime: Boolean(time) };
}

/* An answered slot resolves the doubt the model raised about it. Left in place it would keep
   capturePlanIsClear() false forever, so the conversation would finish and nothing would ever be
   created. Only cleared once every required slot is actually answered. */
function clearResolvedAmbiguity() {
  const unanswered = captureDialogue.required.filter((slot) => !captureDialogue.filled[slot]);
  if (unanswered.length) return;
  if (!Object.keys(captureDialogue.filled).length) return;
  captureMainAsk = "";
  capturePlan = capturePlan.map((entry) =>
    entry.ambiguous ? { ...entry, ambiguous: "" } : entry,
  );
  renderCapturePlan();
}

/* Asks for the next value the sentence is still missing, or finishes. One at a time, because a
   list of blanks is exactly the form this is replacing. */
function advanceCaptureDialogue() {
  captureDialogue.required = captureDialogue.required.filter(
    (slot) => !captureDialogue.filled[slot],
  );
  const next = captureDialogue.required[0] || null;
  captureDialogue.answering = Boolean(next);
  // Which slot the card is currently showing, so a re-read of the same sentence can tell a real
  // change apart from a repeated render.
  captureDialogue.shownSlot = next || "";
  // The pending slot question is rebuilt rather than appended, so re-reading the same sentence
  // cannot stack a second identical question on top of the first. It goes in front of any fixed
  // question, because the value being asked for is the one that is actually missing.
  captureQuestions = captureQuestions.filter(
    (question) => !String(question.id || "").startsWith("slot-"),
  );
  if (next) {
    captureQuestions.unshift({
      id: `slot-${next}`,
      slot: next,
      ...CAPTURE_SLOT_QUESTIONS[next],
    });
  }
  renderCaptureQuestion();
  focusCaptureAnswer();
  if (!next) finishCaptureDialogue();
}

/* Everything the conversation needed is known, so the sentence can finally save itself. The same
   guards scheduleAutoSave() applies run first: a row the person corrected afterwards, or a
   duplicate, still stops it. */
function finishCaptureDialogue() {
  cancelAutoSave();
  if (!captureLastPlan.length || !captureLastText) return;
  scheduleAutoSave(captureLastPlan, captureLastText);
}

function resetCaptureDialogue() {
  captureDialogue = { turns: [], filled: {}, required: [], answering: false, shownSlot: "" };
  captureLastPlan = [];
  captureLastText = "";
  captureImageChoicePending = false;
  captureAnswerOpen = false;
}

function focusCaptureAnswer() {
  const input = document.getElementById("captureQuestionInput");
  // Only take the caret on a pointer-capable device. On a phone this runs as a side effect of
  // the sheet opening and would push the keyboard up over the sheet being read.
  if (input && window.matchMedia?.("(pointer: fine)")?.matches) input.focus();
}

/* Takes one answer in the person's own words. Typed or dictated it goes through the same parser,
   so "tomorrow" and "tomorrow" spoken are the same answer. */
/* Reveals the free-text field for a value the chips do not cover. Closed by default, because the
   point of the chips is that most captures never open it. */
function toggleCaptureAnswerField() {
  captureAnswerOpen = !captureAnswerOpen;
  renderCaptureQuestion();
  if (captureAnswerOpen) focusCaptureAnswer();
}

/* One answer, however it was given. Resolves it, records it, and moves the conversation on — or,
   if the words carried nothing, says so plainly and stays put. Guessing is the single failure this
   whole path exists to prevent. */
function answerSlot(question, answer) {
  const resolved = applyCaptureSlot(question.slot, answer);
  if (!resolved) {
    // A chip can land here too, so the field opens to show what went wrong.
    captureAnswerOpen = true;
    renderCaptureQuestion();
    // Said in the hint line rather than in a card of its own: the sheet has no room for a second
    // panel, and this is one line of feedback, not a conversation. Set *after* the render, because
    // rendering a question clears the hint as the superseded progress line.
    setCaptureHint(`${icon("circle-help")} I could not read “${escapeHtml(answer)}” as ${
      question.slot === "dueTime" ? "a time" : "a day"
    }. Try “${escapeHtml(question.placeholder)}”.`);
    focusCaptureAnswer();
    return;
  }

  // The answer becomes words in the sentence itself, so the box reads as one growing thought
  // rather than a form being filled in beside a transcript. "remind me" becomes "remind me
  // tomorrow" — the same sentence, said out loud, and it can be corrected by hand like any other.
  appendCapturePhrase(answer);
  // "Tomorrow" settles the day but says nothing about the hour, and for a reminder that is
  // genuinely still open — so one more question is asked. Answering "tomorrow at 4" in one go
  // settles both and must not ask twice.
  if (
    question.slot === "dueDate" &&
    !resolved.hadTime &&
    REMINDER_INTENT_RE.test(captureLastText)
  ) {
    captureDialogue.required.push("dueTime");
  }
  clearResolvedAmbiguity();
  advanceCaptureDialogue();
}

/* Adds an answer to the end of the sentence, as words, so the capture box reads as one thought
   being spoken aloud. The caret is placed after the added words and the box is scrolled to it, so
   the person can see and correct exactly what was added — the answer is not hidden anywhere.

   onCaptureInput() is deliberately not called: that would read the new sentence as a fresh one,
   throw away the conversation so far, and re-open the question just answered. The date field has
   already been written, so the reading itself does not need to run again. */
function appendCapturePhrase(phrase) {
  const field = document.getElementById("captureText");
  if (!field) return;
  const current = field.value.trim();
  // Not repeated: tapping "Tomorrow" twice must not produce "tomorrow tomorrow".
  const next = current && /\btomorrow\b/i.test(current) && /^tomorrow$/i.test(phrase)
    ? current
    : `${current}${current ? " " : ""}${phrase}`;
  if (next === current) return;
  field.value = next;
  field.focus();
  const caret = field.value.length;
  field.setSelectionRange(caret, caret);
  // The auto-create compares the text against the one the reading was made from, so a sentence
  // that has just been extended must be re-registered or the timer would never fire.
  captureLastText = next;
}

function submitCaptureAnswer() {
  const input = document.getElementById("captureQuestionInput");
  const question = captureQuestions[0];
  if (!input || !question?.slot) return;
  const answer = input.value.trim();
  if (!answer) return;
  input.value = "";
  answerSlot(question, answer);
}

/* ---------- Dictating the answer ----------

   A separate recogniser from the capture dictation on purpose. That one writes into the main
   textarea, which mid-conversation would overwrite the very sentence being asked about and
   restart the reading. Here the transcript only ever reaches the answer field. */
let captureAnswerRecognition = null;
let captureAnswerActive = false;
let captureAnswerFinal = "";

function setCaptureAnswerMicState(active, message) {
  const button = document.getElementById("captureQuestionMic") ||
    document.querySelector(".capture-question-mic");
  if (button) button.classList.toggle("listening", Boolean(active));
  const status = document.getElementById("captureQuestionStatus");
  if (status) status.textContent = message || "";
}

function stopCaptureAnswerDictation() {
  const recognition = captureAnswerRecognition;
  captureAnswerRecognition = null;
  captureAnswerActive = false;
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.stop();
    } catch (error) {
      // Already stopped by the browser.
    }
  }
  setCaptureAnswerMicState(false, "");
}

function toggleCaptureAnswerDictation() {
  if (captureAnswerActive) {
    stopCaptureAnswerDictation();
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setCaptureAnswerMicState(false, "Dictation is not supported here — type the answer instead.");
    return;
  }
  const input = document.getElementById("captureQuestionInput");
  if (!input) return;

  captureAnswerFinal = "";
  captureAnswerActive = true;
  const recognition = new Recognition();
  captureAnswerRecognition = recognition;
  // The same language the person chose for their captures, so a Tamil or Hindi answer is not
  // transcribed as English.
  recognition.lang = captureVoiceLang || defaultVoiceLang();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) final += `${transcript} `;
      else interim += transcript;
    }
    captureAnswerFinal = `${captureAnswerFinal}${final}`.trim();
    input.value = `${captureAnswerFinal} ${interim}`.trim();
  };
  recognition.onerror = (event) => {
    setCaptureAnswerMicState(
      false,
      event.error === "not-allowed"
        ? "Microphone permission was denied."
        : "No speech was detected — type the answer instead.",
    );
  };
  recognition.onend = () => {
    if (captureAnswerRecognition !== recognition) return;
    captureAnswerRecognition = null;
    captureAnswerActive = false;
    setCaptureAnswerMicState(false, "");
    // An answer spoken aloud is an answer: it goes straight through the same parser as a typed
    // one, so nobody has to reach for the keyboard after saying it.
    if (captureAnswerFinal) submitCaptureAnswer();
  };
  setCaptureAnswerMicState(true, "Listening…");
  try {
    recognition.start();
  } catch (error) {
    captureAnswerActive = false;
    captureAnswerRecognition = null;
    setCaptureAnswerMicState(false, "Dictation could not start — type the answer instead.");
  }
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const DAY_WORD_RE =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;

/* Compact fallback date parser for notes like "tomorrow at 5pm", "in 2 hours" or
   "friday 14:30". Only used when chrono-node isn't available (offline / CDN blocked). */
function parseLocalDate(text, now) {
  const ref = now ? new Date(now) : new Date();
  const t = " " + text.toLowerCase() + " ";

  const relative = t.match(/\bin\s+(\d+)\s*(min|minute|hour|hr|day|week)s?\b/);
  if (relative) {
    const n = parseInt(relative[1], 10);
    const d = new Date(ref);
    if (relative[2].startsWith("min")) d.setMinutes(d.getMinutes() + n);
    else if (relative[2] === "day") d.setDate(d.getDate() + n);
    else if (relative[2] === "week") d.setDate(d.getDate() + n * 7);
    else d.setHours(d.getHours() + n);
    return d;
  }

  const timeMatch =
    t.match(/\b(?:at\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)\b/) ||
    t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ||
    t.match(/\bat\s+(\d{1,2})[:.](\d{2})\b/) ||
    t.match(/\b(\d{1,2}):(\d{2})\b/);

  const d = new Date(ref);

  if (/\btomorrow\b/.test(t)) {
    d.setDate(d.getDate() + 1);
  } else if (DAY_WORD_RE.test(t)) {
    const target = DAY_NAMES.indexOf(t.match(DAY_WORD_RE)[1]);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "friday" said on a Friday means the coming one
    d.setDate(d.getDate() + delta);
  } else if (
    !/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)
  ) {
    return null;
  }

  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    if (timeMatch[3] === "pm" && h < 12) h += 12;
    if (timeMatch[3] === "am" && h === 12) h = 0;
    d.setHours(h, timeMatch[2] ? parseInt(timeMatch[2], 10) : 0, 0, 0);
  } else if (/\btonight\b/.test(t)) d.setHours(21, 0, 0, 0);
  else if (/\bevening\b/.test(t)) d.setHours(19, 0, 0, 0);
  else if (/\bafternoon\b/.test(t)) d.setHours(14, 0, 0, 0);
  else d.setHours(9, 0, 0, 0);

  // No explicit time given and the guess is already behind us — park it an hour out.
  if (!timeMatch && d.getTime() <= ref.getTime()) {
    d.setTime(ref.getTime() + 3600000);
    d.setMinutes(0, 0, 0);
  }

  return d;
}

/* Words that make a time unreliable rather than known. The product rule is that the assistant
   must not invent what a vague phrase means — it asks instead. "Maybe Friday" is not a date. */
const VAGUE_TIME_RE =
  /\b(maybe|perhaps|probably|some\s?time|soon|later|next week|this week|one day|eventually|whenever|any day|or so|ish|approximately|around)\b/i;

/* A promise the person made. The spec calls these out as one of the most useful things the app
   can notice, because an unfulfilled promise is easy to forget. */
const COMMITMENT_RE =
  /\b(i'?ll|i will|i promise|i said i'?d|we'?ll|we will|remind me to|don'?t forget to|i need to remember to)\b/i;

/* Does this read as a document rather than as an appointment?

   Keywords only, and only the words that appear on the actual paper. An appointment card says
   "Dr", "Room", "Appointment"; a warranty says "Warranty", "Valid till", "Model". Matching on the
   expiry wording in particular is what makes this reliable, because "valid till" and "expires on"
   are near-universal on the documents this is for and essentially absent on a clinic slip.

   Deliberately not a model call: this runs on the OCR result of every photographed image, and
   guessing "document" for a photo of a birthday card would be worse than not offering the option. */
const DOCUMENT_TEXT_RE =
  /\b(warranty|guarantee|receipt|invoice|policy|insurance|premium|licen[cs]e|passport|visa card|aadhaar|pan card|valid (?:till|until|upto|up to)|expire[sd]? on|expiry|coverage|policy no|serial no|bill no|model no|manufacturer|shopkeeper|bill to|invoice no)\b/i;

function textLooksLikeDocument(text) {
  return DOCUMENT_TEXT_RE.test(String(text || ""));
}

/* Splits a sentence into clauses. More than one clause usually means more than one thing — a
   task plus a promise, a date plus a follow-up — and the single-value local rules can only
   ever report the first match. That is the main reason to call the model. */
function splitCaptureClauses(text) {
  // Commas count. "Meeting at 9, discuss the app, send the proposal" is three things, and
  // splitting only on full stops read it as one — so the model was never asked, and the
  // second and third parts were lost. Over-splitting only costs one request; under-splitting
  // loses the work, so the comma belongs here.
  return String(text || "")
    .split(/[.;,!?\n]+|\b(?:and then|also|plus|then)\b/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 2);
}

/* ---------- Location ----------

   The one field the sheet can read and never has to ask for: "meeting at the office", "in T Nagar",
   "on Zoom". Deliberately narrow, because a place is optional everywhere it appears and a wrong
   one on an event is worse than none.

   Three refusals, in order:
     - a candidate that reads as a time, a day or a period ("at 5", "in the morning") is skipped,
       and the sentence keeps looking — "meeting at 5 at the office" is about the office
     - a bare common word is only a place when it is one of the known place nouns ("at home"),
       so "in a hurry" and "at the latest" fall through
     - a proper noun after "in" — the one cue that also introduces subjects ("in AI", "in detail")
       — needs the sentence to actually be about somewhere to be, which is what the kind tells us */
const LOCATION_CUE_RE =
  /\b(?:at|in|@|near|inside|outside|venue(?:\s+is|:)?|location(?:\s+is|:)?|place(?:\s+is|:)?)\s+(?::\s*)?/gi;

/* Nouns that are places wherever they appear. Lowercase on purpose: "at home" is the commonest
   location there is and it is never capitalised. */
const LOCATION_PLACE_RE =
  /\b(office|home|house|apartment|flat|place|school|college|university|campus|gym|hospital|clinic|airport|railway station|bus stop|station|cafe|café|restaurant|park|mall|temple|church|mosque|market|hotel|studio|library|beach|cinema|theatre|theater|zoom|google meet|teams|warehouse|godown|ground|stadium|court|bank|post office|canteen|hostel|workshop|lab|factory|site|store|shop|showroom|salon|parlour|hall|room|roof|resort|city centre)\b/i;

/* Words that mean the preposition was about time or scope rather than a place, and the sentence
   words a place's name cannot contain. Leading articles are stripped before this list runs, so
   "at the office" still reads as "office". */
const LOCATION_STOP_RE =
  /^(?:next|last|every|each|this|that|these|those|one|two|three|four|five|six|seven|eight|nine|ten|\d|tomorrow|today|tonight|yesterday|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weeks|month|months|year|years|day|days|hour|hours|minute|minutes|am|pm|o'?clock|noon|midnight|and|or|but|with|then|to|for|from|by|on|at|in|near|inside|outside|is|are|was|were|be|been|due|deadline|soon|later|again|sharply|sharp|latest|least)$/i;
const LOCATION_NOT_A_PLACE_RE =
  /\b(?:\d|am|pm|o'?clock|noon|midnight|morning|afternoon|evening|night|tomorrow|today|tonight|yesterday|days?|weeks?|months?|years?|hours?|minutes?|latest|least|soon|later|again)\b/i;

/* Reads the words after a cue until one of them cannot belong to a place's name. Determiners are
   skipped rather than refused — "at the office" is a location, and refusing "the" would refuse it. */
function takeLocationWords(rest) {
  const lead = String(rest || "")
    .trim()
    .replace(/^(?:the|a|an|my|our|your|his|her|their)\s+/i, "");
  const words = lead.split(/\s+/);
  const taken = [];
  for (const word of words) {
    if (taken.length >= 4) break;
    if (!/^[A-Za-z]/.test(word)) break;
    if (LOCATION_STOP_RE.test(word)) break;
    taken.push(word.replace(/[,;.!?]+$/, "").replace(/^[("'\s]+/, ""));
    if (!taken[taken.length - 1]) taken.pop();
  }
  return taken.join(" ").trim();
}

/* The place this sentence names, or "" when it does not clearly name one. Scans every cue in turn,
   so a time that leads ("meeting at 5 at the office") is skipped rather than mistaken for the
   answer. `kind` is the tie-breaker for the one cue that is genuinely ambiguous: "in" introduces
   subjects as readily as places, so a proper noun after it only counts when the sentence is about
   somewhere to be — which is what event and task already mean. */
function readLocationFromText(text, kind) {
  const body = String(text || "");
  if (!body.trim()) return "";
  const cue = new RegExp(LOCATION_CUE_RE.source, LOCATION_CUE_RE.flags);
  for (const match of body.matchAll(cue)) {
    const candidate = takeLocationWords(body.slice(match.index + match[0].length));
    if (!candidate) continue;
    if (LOCATION_NOT_A_PLACE_RE.test(candidate)) continue;
    if (LOCATION_PLACE_RE.test(candidate)) return candidate.slice(0, 80);
    const properNoun = /^[A-Z]/.test(candidate);
    if (properNoun && ["event", "task", "waiting", "openloop"].includes(kind)) {
      return candidate.slice(0, 80);
    }
  }
  return "";
}

/* ---------- Intelligent auto-fill readers ----------

   The extraction below used to read only kind, priority, due date, person, project, location and
   recurrence — so an expense arrived with no amount, a bill with no due day in its own box, and a
   document with an empty Type. The save path already knew how to read those fields (extraction.js
   falls back to parseAmountFromText etc.), but the sheet never showed them, so the person could
   neither check nor correct what would be saved.

   These readers close that gap deterministically: no model, no network, no guessing. Each returns
   "" when the sentence does not actually say the value, because an empty field plus a gentle
   question is the honest answer — an invented payee on a bank statement is not. */
function merchantFromSentence(text) {
  const body = String(text || "");
  if (!body.trim()) return "";
  const cue = body.match(
    /\b(?:at|from|to|for|via|on|with)\s+([A-Z][\w&.-]{1,30}(?:\s+[A-Z][\w&.-]{1,30}){0,2})\b/,
  );
  if (cue) {
    const name = cue[1].trim().replace(/[.,;:'"]+$/, "");
    if (name.length >= 2 && !/^(?:the|a|an|my|our|this|that)$/i.test(name)) return name.slice(0, 80);
  }
  const brand = body.match(
    /\b(d-mart|dmart|bigbasket|reliance|zomato|swiggy|amazon|flipkart|uber|ola|netflix|spotify|airtel|jio|tata|paytm|phonepe|gpay|google pay|irctc|makemytrip|bookmyshow|decathlon|croma|saravana|nilgiri)\b/i,
  );
  if (brand) return brand[1].trim().slice(0, 80);
  return "";
}

/* When the money was spent. Typed text rarely carries the day ("spent 450 on groceries" is almost
   always today), so an explicit date read from the sentence wins and today is the honest fallback —
   the same rule saveCapture already applied through spentOn || created. Never asked for: "Spent on"
   defaults to today without a question, because that is what the person meant. */
function spentOnFromText(text) {
  const parsed = parseLocalDate(text);
  if (parsed && !Number.isNaN(parsed.getTime())) return isoDateString(parsed);
  return isoDateString(new Date());
}

/* Which drawer of the filing cabinet: warranty, insurance, licence, passport, receipt, manual.
   Read locally so a typed "LIC policy premium due 5th" files as a document rather than a memory
   with an empty Type box. The OCR/image path keeps its own stricter detector; this only covers
   typed or dictated text. */
function docTypeFromText(text) {
  const body = String(text || "").toLowerCase();
  if (/\b(warranty|guarantee)\b/.test(body)) return "warranty";
  if (/\b(insurance|policy|premium|coverage)\b/.test(body)) return "insurance";
  if (/\b(licen[cs]e)\b/.test(body)) return "licence";
  if (/\b(passport|aadhaar|pan card|visa|id card)\b/.test(body)) return "passport";
  if (/\b(receipt)\b/.test(body)) return "receipt";
  if (/\b(manual|handbook|guide)\b/.test(body)) return "manual";
  if (/\b(invoice|bill no|serial no|model no|valid till|valid until|expir)/.test(body)) return "other";
  return "";
}

/* Who issued the paper: "from LIC", "by Croma". A name near an issuer cue or a known brand wins;
   anything else stays empty rather than guessed. */
function docIssuerFromText(text) {
  const body = String(text || "");
  const cue = body.match(/\b(?:from|by|issued by|issuer)\s+([A-Z][\w&.-]{1,30}(?:\s+[A-Z][\w&.-]{1,30}){0,2})\b/);
  if (cue) {
    const name = cue[1].trim().replace(/[.,;:'"]+$/, "");
    if (name.length >= 2 && !/^(?:the|a|an|my|our)$/i.test(name)) return name.slice(0, 80);
  }
  const brand = body.match(/\b(LIC|Croma|Apple|Samsung|Sony|LG|HP|Dell|HDFC|ICICI|SBI|Axis|Kotak|D-Mart|Reliance)\b/);
  if (brand) return brand[1].trim().slice(0, 80);
  return "";
}

/* A reference printed on the paper: "INV-2291", "policy no 12345". An uppercase run with digits
   near a number cue — never a bare word, so "warranty card" yields nothing. The value is validated
   case-sensitively (uppercase-led with a digit), because the cue match is case-insensitive and
   would otherwise accept "policy from" as a reference. */
function docNumberFromText(text) {
  const body = String(text || "");
  const cue = body.match(
    /\b(?:invoice\s+no|inv\s+no|bill\s+no|policy\s+no|serial\s+no|model\s+no|receipt\s+no|order\s+(?:id|no)|invoice|inv|bill|policy|serial|model|receipt|order|no\.?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,29})\b/i,
  );
  if (cue && /^[A-Z0-9]/u.test(cue[1]) && /[0-9]/u.test(cue[1])) return cue[1].trim().slice(0, 80);
  const bare = body.match(/\b([A-Z]{2,}[0-9][A-Z0-9\-/]{2,29})\b/);
  if (bare) return bare[1].trim().slice(0, 80);
  return "";
}

function extractLocally(text) {
  const result = {
    kind: "",
    priority: "",
    dueDate: "",
    person: "",
    project: "",
    location: "",
    recurrence: "none",
    // Money and document values the sentence may carry. Empty is a real answer — it means "not
    // said", and the question builder below asks gently rather than the sheet inventing one.
    amount: "",
    merchant: "",
    category: "",
    spentOn: "",
    billDue: "",
    billType: "",
    billMerchant: "",
    docType: "",
    docExpires: "",
    docIssuer: "",
    docNumber: "",
    // How much the rules actually know. Anything below "high" is a signal to ask the model.
    confidence: "low",
    ambiguous: "",
  };

  // Date/time via chrono-node (loaded from a CDN in index.html)
  if (window.chrono) {
    try {
      const parsed = window.chrono.parseDate(text, new Date());
      if (parsed) result.dueDate = parsed.toISOString();
    } catch (e) {
      /* fall through to the built-in parser below */
    }
  }

  // Built-in fallback so dates still work offline or if the CDN is blocked
  if (!result.dueDate) {
    const local = parseLocalDate(text);
    if (local) result.dueDate = local.toISOString();
  }

  // Date-only values from the text are not always in the future. An appointment card or an old
  // receipt can still be a valid capture even when the calendar date is behind today. Only the
  // generic relative-past wording is rejected here; explicit dates are kept so the picture-choice
  // flow can still ask what to do with the date it actually read.
  // Documents are exempt: a driving licence or passport can be expired and still needs its
  // expiry date preserved so it can be found later by searching "my driving licence expiry".
  const looksDocumentHere = textLooksLikeDocument(text);
  if (captureChannel !== "image" && result.dueDate && new Date(result.dueDate).getTime() < Date.now() - 60000 && !looksDocumentHere)
    result.dueDate = "";

  // A bare day of the month — "pay the bill on the 5th" — is the commonest way an Indian household
  // states a due date and no date parser resolves it, because the month was never said. Tried before
  // the kind is decided, so a bill gets a date and a reminder instead of becoming a memory.
  if (!result.dueDate) {
    const dayOfMonth = resolveDayOfMonth(text);
    if (dayOfMonth) result.dueDate = dayOfMonth;
  }

  // Person: "call/meet/with/for <Capitalized Name>"
  const personMatch = text.match(
    /\b(?:call|meet|with|for|from)\s+([A-Z][a-z]+)\b/,
  );
  if (personMatch) result.person = personMatch[1];

  // …but a debt names the person FIRST: "Ravi owes me ₹500". None of the verbs above appear, so the
  // name was dropped and the row arrived with an amount and no one attached to it — which is an
  // amount nobody can chase. Gated on the debt shape, so a sentence that merely starts with a name
  // does not get one read out of it.
  if (!result.person && textLooksLikeMoneyOwed(text)) {
    const debtor = text.match(/\b([A-Z][a-z]{2,})\s+(?:owes?|lends?|borrowed)\b/);
    if (debtor) result.person = debtor[1];
  }

  // Priority from urgency words
  if (/\b(urgent|asap|critical|important)\b/i.test(text))
    result.priority = "high";
  else if (/\b(sometime|eventually|whenever|low priority)\b/i.test(text))
    result.priority = "medium";

  // Recurrence — "everyday" (one word) is how people actually type "every day".
  if (/\b(?:every\s?day|daily)\b/i.test(text)) result.recurrence = "daily";
  else if (/\b(?:every\s?week|weekly)\b/i.test(text)) result.recurrence = "weekly";
  else if (/\b(?:every\s?month|monthly)\b/i.test(text)) result.recurrence = "monthly";

  // Project — match against known project names
  const proj = state.projects.find((p) =>
    text.toLowerCase().includes(p.name.toLowerCase()),
  );
  if (proj) result.project = proj.name;

  // Kind
  result.kind = detectType(text);
  // An expense is money already spent, so it is read before anything else here. "Spent ₹450 for
  // groceries" contains no task verb, so without this it fell through to detectType and became a
  // memory — a spending record filed as a note, which is the one thing this module must never do.
  // It needs an amount as well as the wording: "pay the bill on the 5th" is money, but the money has
  // not been spent yet and that is a reminder, not an expense.
  if (textLooksLikeMoneyOwed(text)) {
    result.kind = "task";
  } else if (parseAmountFromText(text) !== null && textLooksLikeBill(text)) {
    result.kind = "bill";
  } else if (parseAmountFromText(text) !== null && textLooksLikeExpense(text)) {
    result.kind = "expense";
  } else if (/\bwaiting (on|for)\b/i.test(text)) result.kind = "waiting";
  else if (/\b(need to decide|undecided|not sure yet)\b/i.test(text))
    result.kind = "openloop";
  // A stated preference or fact about someone is knowledge, not work: "Ravi prefers WhatsApp".
  // Without this the "email"/"call" verbs below read it as a task, which is the one kind error a
  // memory engine must never make.
  else if (/\b(prefers?|likes?|dislikes|hates?|uses|is a|works (at|with)|lives? in|knows?)\b/i.test(text))
    result.kind = "memory";

  // A place, when the sentence names one. Read after the kind on purpose: a proper noun is only a
  // location the app may be sure of when the sentence is about somewhere to be. Never guessed and
  // never asked for — "" is a perfectly good answer for an optional field.
  result.location = readLocationFromText(text, result.kind);

  // ---------- Intelligent auto-fill: every field the sentence actually carries ----------
  // The amount is the one the money tests pin: only a currency-marked number counts, so "paid 3
  // people" stays null and "Spent ₹450" becomes 45000 paise. Shown in plain rupees in the box.
  const amountMinor = parseAmountFromText(text);
  if (amountMinor !== null && amountMinor > 0) {
    result.amount = String(Math.floor(amountMinor / PAISE_PER_RUPEE));
  }
  const shop = merchantFromSentence(text);
  if (shop) {
    result.merchant = shop;
    result.billMerchant = shop;
  }
  const category = guessMoneyCategory(text);
  if (category) result.category = category;
  // Money already spent happened on the day the sentence says, or today — never left blank, because
  // a blank Spent-on silently becomes "today" at save time and the sheet should show what it means.
  if (result.kind === "expense") result.spentOn = spentOnFromText(text);
  // A bill's own Due-on box mirrors the due date the sentence gave, as a calendar day.
  if (result.kind === "bill" && result.dueDate) {
    const due = new Date(result.dueDate);
    if (!Number.isNaN(due.getTime())) result.billDue = isoDateString(due);
  }
  if (result.kind === "bill") result.billType = guessBillType(text) || "bill";
  // A document names its own drawer. Typed or dictated text is also admitted when it reads like a
  // document — a photographed paper keeps its stricter image path, this never overrides it.
  const looksDocument = looksDocumentHere;
  if (result.kind === "bill" && /\b(policy|premium|insurance)\b/i.test(text)) result.kind = "document";
  // Only a sentence with no task or event signal becomes a document: "Car insurance policy" fell
  // through detectType as a memory, while "Send the invoice to Ravi" carries the task verb "send"
  // and must stay a task — a document keyword alone must not steal work.
  else if (result.kind === "memory") {
    if (looksDocument && docTypeFromText(text)) result.kind = "document";
  }
  if (result.kind === "document") {
    result.docType = docTypeFromText(text);
    result.docIssuer = docIssuerFromText(text);
    result.docNumber = docNumberFromText(text);
    // An expiry is a calendar day, not a datetime: the doc box is type=date. A "valid till" phrase
    // resolves through the same date readers as everything else; anything unparseable stays empty
    // and is asked for gently rather than invented.
    const expiry = result.dueDate ? new Date(result.dueDate) : null;
    if (expiry && !Number.isNaN(expiry.getTime())) {
      result.docExpires = isoDateString(expiry);
      result.dueDate = "";
    }
  }

  // How much do the rules actually know? A vague phrase is a reason to ask, not to guess.
  if (VAGUE_TIME_RE.test(text)) {
    result.confidence = "low";
  } else if (result.dueDate && result.kind) {
    result.confidence = "high";
  } else if (result.dueDate || result.kind) {
    result.confidence = "medium";
  }

  return result;
}

/* Decides whether the local rules are enough. They are for a plain "call Ravi tomorrow"; they
   are not for a sentence carrying a promise and a date, for a vague time, or for anything they
   only half-read. Calling the model costs a request, so it is reserved for those cases. */
function captureNeedsModelHelp(text, local) {
  if (VAGUE_TIME_RE.test(text)) return true;
  if (COMMITMENT_RE.test(text)) return true;
  if (local?.confidence !== "high") return true;
  return splitCaptureClauses(text).length > 1;
}
