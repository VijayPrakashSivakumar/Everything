/* ---------- Voice capture: single-click record + live transcribe ----------
   Complete rework of the voice capturing option. One tap starts both the
   microphone recording (MediaRecorder) and the live speech recogniser
   (Web Speech API) at the same moment, so words are captured as they are
   spoken — not saved as a dead audio attachment.

   The transcript lands in the capture box through applyVoiceTranscript(),
   which calls onCaptureInput() — the same entry point as typing. From there
   the existing smart-capture pipeline understands the sentence
   (task / event / memory / waiting / openloop), builds the plan, and
   saveCapture() stores it exactly like any other capture.

   Local language support: English, Tamil, Hindi, Telugu, Kannada,
   Malayalam. The language is auto-detected from the script of what is
   spoken, remembered between captures, and can be corrected with chips.
   The dictated language is saved with the capture so the transcript reads
   back correctly later.

   Fallback: if the browser has no speech recogniser (Firefox) the audio is
   still recorded, and the private on-device reader (Whisper via
   transformers.js) can transcribe the recording afterwards without sending
   audio anywhere.
*/

/* ---------- Dictation languages ---------- */
/* `tag` is the BCP-47 code the Web Speech API expects; `label` is shown
   in the picker; `hint` is a native-script example. */
const VOICE_LANGUAGES = [
  { tag: "en-IN", label: "English", hint: "English" },
  { tag: "ta-IN", label: "Tamil", hint: "தமிழ்" },
  { tag: "hi-IN", label: "Hindi", hint: "हिन्दी" },
  { tag: "te-IN", label: "Telugu", hint: "తెలుగు" },
  { tag: "kn-IN", label: "Kannada", hint: "ಕನ್ನಡ" },
  { tag: "ml-IN", label: "Malayalam", hint: "മലയാളം" },
];

const VOICE_TRANSLATE_MEMORY_KEY = "everything_capture_translate";

/* ---------- Automatic language detection ----------

   Script is the one signal about language that cannot be guessed at:
   Tamil characters are Tamil whether they appear in a sentence or alone.
   Latin script could be English, Hindi transliteration, Tamil transliteration
   or anything else — so Latin falls back to the browser/default guess until
   the person picks or corrects a chip.

   Two rules keep this safe rather than clever:
     - it only ever corrects a guess the app made itself; a chip the person
       tapped is a decision and is never overridden (captureVoiceLangAuto)
     - a detection is remembered, so the correction is needed at most once
       per person
*/
const CAPTURE_SCRIPT_LANGUAGES = [
  { script: "Tamil", tag: "ta-IN" },
  { script: "Devanagari", tag: "hi-IN" },
  { script: "Telugu", tag: "te-IN" },
  { script: "Kannada", tag: "kn-IN" },
  { script: "Malayalam", tag: "ml-IN" },
];
const CAPTURE_LATIN_TAG = "en-IN";

/* A small set of common Romanised function words so short Romanised Indian
   speech is not forced into English when the person clearly means their own
   language. Kept deliberately small — this is a hint, not a dictionary. */
const CAPTURE_ROMAN_WORDS = [
  "hai", "hain", "hona", "karna", "lena", "dena", "jana", "aana", "ka", "ki", "ke",
  "ko", "mein", "se", "ne", "to", "par", "aur", "ya", "nahi", "nahin", "main",
  "tum", "aap", "yeh", "woh", "kya", "kab", "kahan", "kaise", "kyun",
  "enaku", "enga", "ippadi", "eppadi", "edho", "edhai", "naan",
  "nee", "avar", "avalo", "ungal", "naan", "un", "vanthu", "poga",
  "chellu", "nammakam", "sari", "rendu", "moonnu", "naalu", "ainthu",
  "namaskara", " hegiddira", "yenu", "yavaga", "yenu", "nanu", "neenu",
  "avanu", "avalu", "namma", "omme", "rendu", "mooru", "nalku", "aidhu",
  "namaskaram", "sukhamano", "ethra", "eppozhu", "evide", "enthinu",
  "niyan", "aval", "avar", "engal", "onnu", "randu", "moonu", "naalu", "ainchu",
];

/* ---------- Voice capture state ---------- */
let mediaRecorder = null;
let recordedChunks = [];
let recordingSeconds = 0;
let recordingInterval = null;
let pendingBlob = null;
let pendingBlobExt = null;

let captureVoiceRecognition = null;
let captureVoiceActive = false;
let captureVoiceFinal = "";
let captureVoiceBase = "";

let voiceTranscript = "";
let voiceTranscriptBase = "";

let captureVoiceLang = "";
let captureVoiceLangAuto = true;
let captureVoiceLanguage = "";
let voiceLangSwapCount = 0;
let voiceRecordingWasLive = false;

let voiceTranscriptionStopTimer = null;
let voiceTranscriptionDone = null;
let voiceTranscriptionSettled = true;

let captureRecordWantListening = false;
let captureRecordRecognition = null;

let voiceMicRetryUsed = false;
let voiceMicPermission = null;

let voiceCaptureBusy = false;
let voiceTranslateToken = 0;

/* ---------- Language helpers ---------- */

function defaultVoiceLang() {
  try {
    const remembered = localStorage.getItem("everything_capture_voice_lang");
    if (remembered && VOICE_LANGUAGES.some((entry) => entry.tag === remembered))
      return remembered;
  } catch (error) {
    // Storage unavailable — fall through to the default below.
  }
  return "en-IN";
}

function captureLanguageLabel(tag) {
  const entry = VOICE_LANGUAGES.find((entry) => entry.tag === tag);
  return entry ? entry.label : tag;
}

function detectCaptureLanguage(text) {
  if (!text || !text.trim()) return "";
  const trimmed = text.trim();
  for (const entry of CAPTURE_SCRIPT_LANGUAGES) {
    const range = entry.script === "Tamil"
      ? "\u0B80-\u0BFF"
      : entry.script === "Devanagari"
        ? "\u0900-\u097F"
        : entry.script === "Telugu"
          ? "\u0C00-\u0C7F"
          : entry.script === "Kannada"
            ? "\u0C80-\u0CFF"
            : "\u0D00-\u0D7F";
    const re = new RegExp(`[${range}]`);
    if (re.test(trimmed)) return entry.tag;
  }
  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/);
  let hindiScore = 0;
  let tamilScore = 0;
  for (const word of words) {
    if (CAPTURE_ROMAN_WORDS.includes(word)) {
      if (
        ["ena", "enga", "ippadi", "eppadi", "edho", "edhai", "naan", "nee",
         "avar", "ungal", "vanthu", "poga", "chellu", "sari"].includes(word)
      ) {
        tamilScore += 1;
      } else {
        hindiScore += 1;
      }
    }
  }
  if (tamilScore > hindiScore && tamilScore > 0) return "ta-IN";
  if (hindiScore > 0) return "hi-IN";
  return "";
}

function syncDetectedCaptureLanguage(spoken) {
  if (!captureVoiceLangAuto) return "";
  const detected = detectCaptureLanguage(spoken);
  if (!detected || detected === captureVoiceLang) return "";
  captureVoiceLang = detected;
  rememberCaptureLanguage(detected);
  renderVoiceLanguages();
  return detected;
}

function rememberCaptureLanguage(tag) {
  try {
    localStorage.setItem("everything_capture_voice_lang", tag);
  } catch (error) {
    // Storage unavailable — silently skip.
  }
  captureVoiceLangAuto = false;
}

function pickVoiceLang(tag, manual = true) {
  if (tag === "auto") {
    captureVoiceLangAuto = true;
    captureVoiceLang = defaultVoiceLang();
  } else {
    captureVoiceLang =
      VOICE_LANGUAGES.some((entry) => entry.tag === tag) ? tag : defaultVoiceLang();
    if (manual) {
      captureVoiceLangAuto = false;
      rememberCaptureLanguage(captureVoiceLang);
    }
  }
  syncVoiceLangChips();
}

function resetVoiceLangForCapture() {
  captureVoiceLangAuto = true;
  pickVoiceLang(defaultVoiceLang(), false);
  syncVoiceTranslateRow();
}

function syncVoiceLangChips() {
  const row = document.getElementById("voiceLangRow");
  if (!row) return;
  document
    .querySelectorAll("#voiceLangRow .type-chip")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.dataset.lang === "auto"
          ? captureVoiceLangAuto
          : el.dataset.lang === captureVoiceLang,
      ),
    );
}

function renderVoiceLanguages() {
  const row = document.getElementById("voiceLangRow");
  if (!row) return;
  if (!captureVoiceLang) captureVoiceLang = defaultVoiceLang();
  row.innerHTML = '';
  const autoChip = document.createElement("div");
  autoChip.className = "type-chip" + (captureVoiceLangAuto ? " active" : "");
  autoChip.dataset.lang = "auto";
  autoChip.setAttribute("role", "button");
  autoChip.setAttribute("aria-pressed", captureVoiceLangAuto);
  autoChip.onclick = () => pickVoiceLang("auto", true);
  autoChip.innerHTML = `<i data-lucide="circle-help" aria-hidden="true"></i><span>Auto</span>`;
  row.appendChild(autoChip);
  for (const entry of VOICE_LANGUAGES) {
    const chip = document.createElement("div");
    chip.className =
      "type-chip" + (entry.tag === captureVoiceLang ? " active" : "");
    chip.dataset.lang = entry.tag;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-pressed", entry.tag === captureVoiceLang);
    chip.onclick = () => pickVoiceLang(entry.tag, true);
    chip.innerHTML = `<i data-lucide="mic" aria-hidden="true"></i><span>${entry.label}</span> <span style="opacity:0.6">${entry.hint}</span>`;
    row.appendChild(chip);
  }
  refreshIcons();
}

/* ---------- Translation (optional, opt-in) ---------- */

let captureVoiceTranslateTarget = null;

function rememberedVoiceTranslateTarget() {
  try {
    const stored = localStorage.getItem(VOICE_TRANSLATE_MEMORY_KEY);
    return stored === null ? "" : stored;
  } catch (error) {
    return "";
  }
}

function rememberVoiceTranslateTarget(tag) {
  try {
    if (tag) localStorage.setItem(VOICE_TRANSLATE_MEMORY_KEY, tag);
    else localStorage.removeItem(VOICE_TRANSLATE_MEMORY_KEY);
  } catch (error) {
    // Storage unavailable — silently skip.
  }
}

function syncVoiceTranslateRow() {
  if (captureVoiceTranslateTarget === null)
    captureVoiceTranslateTarget = rememberedVoiceTranslateTarget();
  const select = document.getElementById("voiceTranslateTarget");
  if (!select) return;
  if (
    captureVoiceTranslateTarget &&
    !Array.from(select.options).some((option) => option.value === captureVoiceTranslateTarget)
  )
    captureVoiceTranslateTarget = "";
  select.value = captureVoiceTranslateTarget;
}

function onVoiceTranslateChange(value) {
  captureVoiceTranslateTarget =
    VOICE_LANGUAGES.some((entry) => entry.tag === value) ? value : "";
  rememberVoiceTranslateTarget(captureVoiceTranslateTarget);
}

function voiceTagToTranslateName(tag) {
  if (!tag) return "";
  const entry = VOICE_LANGUAGES.find((entry) => entry.tag === tag);
  return entry ? entry.label : tag;
}

function maybeTranslateVoiceCapture(heard) {
  const target = captureVoiceTranslateTarget;
  if (!target || !heard) return;
  const sourceTag = captureVoiceLanguage || captureVoiceLang || "";
  if (sourceTag === target) return;
  const token = (voiceTranslateToken += 1);
  setVoiceRecordLabel("Translating…", "languages");
  setVoiceLiveTranscript(`Translating to ${voiceTagToTranslateName(target)}…`);
  translateVoiceText(heard, sourceTag, target)
    .then((translated) => {
      if (token !== voiceTranslateToken) return;
      const input = document.getElementById("captureText");
      if (!input || !translated) return;
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
      if (token === voiceTranslateToken)
        setVoiceRecordLabel("Capture again", "mic");
    });
}

async function translateVoiceText(text, fromTag, toTag) {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "translate",
      text,
      from: fromTag,
      to: toTag,
      today,
    }),
  });
  if (!res.ok) throw new Error(`translation failed: ${res.status}`);
  const data = await res.json();
  return data.translation || "";
}

/* ---------- Voice UI state ---------- */

function setVoiceRecordLabel(label, icon) {
  const btn = document.getElementById("voiceRecordBtn") || document.getElementById("captureMicBtn");
  if (!btn) return;
  if (btn.id === "captureMicBtn") {
    btn.setAttribute("aria-label", label);
    btn.title = label;
  } else {
    btn.innerHTML = `<i data-lucide="${icon || "mic"}" aria-hidden="true"></i><span id="voiceRecordLabel">${label}</span>`;
  }
  refreshIcons();
}

function setVoiceRecordState(state) {
  const btn = document.getElementById("voiceRecordBtn");
  if (btn) btn.dataset.state = state;
  syncCaptureMicState(state);
}

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
  if (!document.getElementById("voiceRecordBtn")) {
    mic.title =
      state === "recording"
        ? "Stop voice capture"
        : state === "stopping"
          ? "Converting speech to text"
          : "Start voice capture";
  }
}

function setVoiceLiveTranscript(text) {
  const live = document.getElementById("voiceLiveTranscript");
  if (live) live.textContent = text || "";
}

function setVoiceDictationStatus(message) {
  const status = document.getElementById("voiceDictationStatus");
  if (status) status.textContent = message || "";
}

function setVoiceLocalSttVisible(visible) {
  const button = document.getElementById("voiceLocalSttBtn");
  if (button) button.style.display = visible ? "block" : "none";
}

/* ---------- Silence auto-stop ---------- */

let voiceSilenceStopTimer = null;

function clearVoiceSilenceStop() {
  if (voiceSilenceStopTimer) {
    clearTimeout(voiceSilenceStopTimer);
    voiceSilenceStopTimer = null;
  }
}

function armVoiceSilenceStop() {
  clearVoiceSilenceStop();
  voiceSilenceStopTimer = setTimeout(() => {
    if (!captureRecordWantListening) return;
    settleVoiceCapture();
  }, 8000);
}

/* ---------- Core: write transcript into the capture pipeline ---------- */

function applyVoiceTranscript(finalText) {
  voiceTranscript = finalText;
  const spoken = voiceTranscript.trim();
  const input = document.getElementById("captureText");
  input.value = [voiceTranscriptBase, spoken].filter(Boolean).join(" ");
  setVoiceLiveTranscript(spoken ? `Heard: “${spoken}”` : "");
  if (spoken) {
    const detected = syncDetectedCaptureLanguage(spoken);
    if (detected) {
      captureVoiceLanguage = detected;
      setVoiceLiveTranscript(
        `Heard: “${spoken}” — detected ${captureLanguageLabel(detected)}.`,
      );
    }
    maybeTranslateVoiceCapture(spoken);
  } else {
    onCaptureInput();
  }
}

/* ---------- Settle: finish a capture (tap, silence, or backstop) ---------- */

function settleVoiceCapture() {
  voiceTranscriptionSettled = true;
  clearVoiceSilenceStop();
  if (voiceTranscriptionStopTimer) {
    clearTimeout(voiceTranscriptionStopTimer);
    voiceTranscriptionStopTimer = null;
  }
  const heard = voiceTranscript.trim();

  stopVoiceTranscription();
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();

  captureRecordWantListening = false;
  captureRecordRecognition = null;
  setVoiceRecordState("idle");
  setVoiceRecordLabel(heard ? "Capture again" : "Capture voice", "mic");
  captureVoiceFinal = heard;
  setVoiceLocalSttVisible(false);

  if (heard) {
    setVoiceLiveTranscript(`Heard: “${heard}”`);
    maybeTranslateVoiceCapture(heard);
  } else {
    setVoiceLiveTranscript(
      voiceRecordingWasLive
        ? "Nothing was heard in that recording. The audio is saved — type what you meant instead. Tap the mic to try again."
        : "",
    );
    onCaptureInput();
  }
  voiceRecordingWasLive = false;
}

/* ---------- Speech recognition (live transcription) ---------- */

function startVoiceTranscription() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    setVoiceLiveTranscript("Recording your voice. I’ll turn it into text when you stop.");
    return false;
  }
  captureRecordWantListening = true;
  voiceTranscriptionSettled = false;
  voiceTranscriptionDone = null;
  const recognition = new Recognition();
  captureRecordRecognition = recognition;
  recognition.lang = captureVoiceLang || defaultVoiceLang();
  recognition.continuous = true;
  recognition.interimResults = true;
  let voiceHeardWords = false;
  recognition.onstart = () => {
    setVoiceLiveTranscript("Listening… speak your capture.");
    armVoiceSilenceStop();
  };
  recognition.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      let line = "";
      for (const alt of result) line += alt.transcript;
      if (result.isFinal) {
        voiceHeardWords = true;
        finalText += line + " ";
      } else {
        interim += line;
      }
    }
    const combined = [voiceTranscriptBase, finalText.trim(), interim]
      .filter(Boolean).join(" ");
    const input = document.getElementById("captureText");
    if (input) input.value = combined;
    setVoiceLiveTranscript(combined
      ? `Listening… ${interim ? `“${interim}”` : ""}${finalText.trim() ? " (heard so far)" : ""}`.trim()
      : "Listening… speak your capture.");
    if (finalText.trim()) {
      voiceTranscriptBase = [voiceTranscriptBase, finalText.trim()].filter(Boolean).join(" ");
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      setVoiceLiveTranscript("Microphone permission was denied.");
      setVoiceRecordState("idle");
      setVoiceRecordLabel("Capture voice", "mic");
      captureRecordWantListening = false;
      captureRecordRecognition = null;
      return;
    }
    if (event.error === "no-speech") {
      if (voiceHeardWords) {
        setVoiceLiveTranscript("Paused — still listening…");
        armVoiceSilenceStop();
      } else {
        settleVoiceCapture();
      }
      return;
    }
    if (event.error === "audio-capture") {
      setVoiceLiveTranscript(
        "No microphone was found or blocked — allow microphone access and tap the mic to try again.",
      );
      setVoiceRecordState("idle");
      setVoiceRecordLabel("Capture voice", "mic");
      captureRecordWantListening = false;
      captureRecordRecognition = null;
      return;
    }
    if (event.error === "language-not-supported") {
      setVoiceLiveTranscript(
        "This browser cannot transcribe that language live — the audio is still saved. Tap the mic to record again.",
      );
      captureRecordWantListening = false;
      captureRecordRecognition = null;
      return;
    }
    if (event.error === "network") {
      voiceNetworkMisses += 1;
      setVoiceLiveTranscript(
        voiceNetworkMisses > 2
          ? "The speech service keeps failing — check your connection, then tap the mic again."
          : "Speech service unreachable — retrying.",
      );
      if (voiceNetworkMisses > 2) captureRecordWantListening = false;
      return;
    }
    setVoiceLiveTranscript(
      "Speech could not be transcribed — tap the mic to try again.",
    );
  };
  recognition.onend = () => {
    captureRecordRecognition = null;
    if (voiceTranscriptionSettled) return;
    settleVoiceCapture();
  };
  try {
    recognition.start();
    captureVoiceActive = true;
    return true;
  } catch (error) {
    captureRecordRecognition = null;
    captureVoiceActive = false;
    setVoiceLiveTranscript("Could not start speech recognition — try again or type your capture instead.");
    return false;
  }
}

function stopVoiceTranscription() {
  captureRecordWantListening = false;
  clearVoiceSilenceStop();
  if (voiceTranscriptionStopTimer) {
    clearTimeout(voiceTranscriptionStopTimer);
    voiceTranscriptionStopTimer = null;
  }
  try {
    if (captureRecordRecognition) {
      captureRecordRecognition.onend = null;
      captureRecordRecognition.onresult = null;
      captureRecordRecognition.onerror = null;
      captureRecordRecognition.stop();
    }
  } catch (error) {
    // Already stopped by the browser; nothing to unwind.
  }
  captureRecordRecognition = null;
  captureVoiceActive = false;
}

/* ---------- Recording (audio attachment) ---------- */

function startVoiceRecording(stream) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  recordedChunks = [];
  recordingSeconds = 0;
  const timerEl = document.getElementById("voiceTimer");
  if (timerEl) timerEl.textContent = "";
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    pendingBlob = blob;
    pendingBlobExt = "webm";
    const preview = document.getElementById("voicePreview");
    if (preview) {
      preview.style.display = "block";
      preview.src = URL.createObjectURL(blob);
    }
    recordingSeconds = 0;
    if (recordingInterval) {
      clearInterval(recordingInterval);
      recordingInterval = null;
    }
    if (timerEl) timerEl.textContent = "";
  };
  mediaRecorder.onerror = () => {
    mediaRecorder = null;
  };
  mediaRecorder.start(200);
  recordingInterval = setInterval(() => {
    recordingSeconds++;
    if (timerEl)
      timerEl.textContent = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
  }, 1000);
}

/* ---------- One-click entry point ---------- */

async function toggleVoiceRecording() {
  if (captureVoiceActive) {
    stopVoiceDictation();
    return;
  }
  if (voiceCaptureBusy) return;
  const recording = Boolean(mediaRecorder && mediaRecorder.state === "recording");
  const listening = Boolean(captureRecordRecognition);
  if (recording || listening) {
    if (!listening || voiceTranscriptionSettled) {
      settleVoiceCapture();
    } else {
      voiceTranscriptionSettled = true;
      voiceTranscriptionDone = settleVoiceCapture;
      setVoiceRecordState("stopping");
      setVoiceRecordLabel("Converting speech to text...", "loader-circle");
      setVoiceLiveTranscript("Converting speech to text...");
      try {
        captureRecordRecognition.stop();
      } catch (error) {
        // Already ended; the backstop below still runs the settle.
      }
      voiceTranscriptionStopTimer = setTimeout(settleVoiceCapture, 3000);
    }
    if (recording) mediaRecorder.stop();
    return;
  }
  /* ---------- Start ---------- */
  voiceCaptureBusy = true;
  voiceTranscriptBase = "";
  voiceTranscript = "";
  captureVoiceFinal = "";
  captureVoiceLanguage = "";
  captureVoiceActive = false;
  const hasSpeechRecognition = !!(
    window.SpeechRecognition || window.webkitSpeechRecognition
  );
  const hasMediaDevices = !!(
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
  );
  const hasMediaRecorder = !!window.MediaRecorder;
  if (!hasSpeechRecognition && !hasMediaDevices && !hasMediaRecorder) {
    setVoiceLiveTranscript(
      "Your browser cannot record or transcribe voice — please type your capture instead.",
    );
    setVoiceRecordState("idle");
    voiceCaptureBusy = false;
    return;
  }
  const transcriptionLive = startVoiceTranscription();
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVoiceRecording(stream);
    setVoiceRecordState("recording");
    setVoiceRecordLabel("Stop capture", "square");
    setVoiceLiveTranscript(
      transcriptionLive
        ? "Listening… speak your capture."
        : "Recording your voice. I’ll turn it into text when you stop.",
    );
    voiceRecordingWasLive = true;
  } catch (micError) {
    // Microphone access was blocked — the recording could not start.
    setVoiceLiveTranscript(
      "Microphone access was blocked. Allow microphone access for this site, then tap the mic to try again.",
    );
    setVoiceRecordState("idle");
    setVoiceRecordLabel("Capture voice", "mic");
    if (!transcriptionLive) {
      stopVoiceTranscription();
    }
    voiceCaptureBusy = false;
    return;
  } finally {
    voiceCaptureBusy = false;
  }
}

/* ---------- Dictation (answering capture questions by voice) ---------- */

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
}

/* ---------- Private, on-device speech recognition (fallback) ---------- */

let speechEngine = null;
let speechEngineLoading = false;
let speechEngineLoadPromise = null;

async function loadSpeechEngine() {
  if (speechEngine) return speechEngine;
  if (speechEngineLoadPromise) return speechEngineLoadPromise;
  speechEngineLoadPromise = (async () => {
    const { pipeline } = await import(
      "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/+esm"
    );
    speechEngine = await pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en",
    );
    return speechEngine;
  })();
  return speechEngineLoadPromise;
}

function decodeAudioForWhisper(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;
    audio.oncanplaythrough = () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const track = ctx.createMediaElementSource(audio);
      track.connect(ctx.destination);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const pcm = [];
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        pcm.push(new Float32Array(input));
      };
      processor.connect(ctx.destination);
      audio.onended = () => {
        processor.disconnect();
        ctx.close();
        URL.revokeObjectURL(url);
        let total = 0;
        for (const chunk of pcm) total += chunk.length;
        const samples = new Float32Array(total);
        let offset = 0;
        for (const chunk of pcm) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(samples);
      };
      audio.play().catch(reject);
    };
    audio.onerror = reject;
  });
}

async function transcribeRecordingLocally() {
  if (!pendingBlob) {
    setVoiceLiveTranscript(
      "Record something first, then this can read it on this device.",
    );
    return;
  }
  const button = document.getElementById("voiceLocalSttBtn");
  if (button) button.disabled = true;
  setVoiceLiveTranscript(
    "Preparing the private reader (first run downloads it, once)…",
  );
  try {
    const engine = await loadSpeechEngine();
    const samples = await decodeAudioForWhisper(pendingBlob);
    const output = await engine(
      samples,
      { sampling_rate: 16000, chunk_length_s: 30, stride_length_s: 5 },
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

/* ---------- Cleanup on capture close ---------- */

function resetVoiceCaptureState() {
  captureVoiceLanguage = "";
  voiceTranscript = "";
  voiceTranscriptBase = "";
  voiceLangSwapCount = 0;
  voiceCaptureBusy = false;
  voiceRecordingWasLive = false;
  stopVoiceTranscription();
  setVoiceLiveTranscript("");
  setVoiceLocalSttVisible(false);
  resetVoiceLangForCapture();
  renderVoiceLanguages();
  pendingBlob = null;
  pendingBlobExt = null;
  if (mediaRecorder && mediaRecorder.state === "recording")
    mediaRecorder.stop();
  setVoiceRecordLabel("Capture voice", "mic");
  setVoiceRecordState("idle");
}

function activateVoiceChannel() {
  const input = document.getElementById("captureText");
  if (input) input.placeholder = "Type or dictate a note…";
  const panel = document.getElementById("voiceCaptureUI");
  if (panel) panel.style.display = "block";
}

function deactivateVoiceChannel() {
  const panel = document.getElementById("voiceCaptureUI");
  if (panel) panel.style.display = "none";
}

/* Public surface used by closeCapture() in capture.js and elsewhere. */
window.__voiceCapture = {
  resetVoiceCaptureState,
  activateVoiceChannel,
  deactivateVoiceChannel,
  stopVoiceTranscription,
  stopVoiceDictation,
  applyVoiceTranscript,
  settleVoiceCapture,
  toggleVoiceRecording,
  startVoiceTranscription,
  transcribeRecordingLocally,
  setVoiceRecordState,
  setVoiceRecordLabel,
  setVoiceLiveTranscript,
  setVoiceDictationStatus,
  setVoiceLocalSttVisible,
  defaultVoiceLang,
  pickVoiceLang,
  resetVoiceLangForCapture,
  renderVoiceLanguages,
  syncVoiceLangChips,
  syncVoiceTranslateRow,
  onVoiceTranslateChange,
  captureVoiceFinal,
  captureVoiceLanguage,
  captureVoiceLang,
  captureVoiceLangAuto,
  voiceTranscript,
  voiceTranscriptBase,
};