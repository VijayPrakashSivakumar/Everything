/* ---------- Local extraction (smart capture) ----------
   The server owns the cloud prompt. The local model gets its own, shorter one: a small model on a
   laptop follows a direct instruction better than a long rule list, and `format: "json"` in
   localModelComplete does the schema work. The vocabulary below must stay identical to the
   server's buildExtractionPrompt, which ui-structure pins by comparing the two lists. */
const LOCAL_EXTRACTION_KINDS = ["task", "event", "memory", "waiting", "openloop", "agenda"];
const LOCAL_EXTRACTION_PRIORITIES = ["high", "medium", "low"];
const LOCAL_EXTRACTION_RECURRENCE = ["none", "daily", "weekly", "monthly", "yearly"];

function buildLocalExtractionPrompt(text, today) {
  return `Today is ${today}. Turn this sentence into JSON for a personal productivity app.

Return ONLY this shape:
{"items":[{"kind":"${LOCAL_EXTRACTION_KINDS.join("|")}","title":"short imperative title","dueDate":"ISO 8601 or empty string","person":"name or empty string","project":"name or empty string","priority":"${LOCAL_EXTRACTION_PRIORITIES.join("|")} or empty string","recurrence":"${LOCAL_EXTRACTION_RECURRENCE.join("|")}","confidence":"high|medium|low","ambiguous":"one short question or empty string"}]}

Rules: one sentence can carry several things, so return one entry per distinct thing rather than merging them. Never invent a date; if the wording is vague, leave dueDate empty. "waiting for X" is waiting. An undecided question is openloop. A fact about a person is memory.

Sentence: ${text}`;
}

/* The reply is written straight into the capture form, so anything the form cannot represent has to
   be dropped rather than passed through. Mirrors the server's cleanExtraction field for field, so a
   capture reads the same whichever model answered. */
function cleanLocalExtractionItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const oneOf = (value, allowed, fallback) => {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    return allowed.includes(v) ? v : fallback;
  };
  const str = (value) => (typeof value === "string" ? value.trim() : "");
  const title = str(raw.title).slice(0, 200);
  // A row with no title is not a thing the person can act on, and the plan path drops these too.
  if (!title) return null;
  return {
    kind: oneOf(raw.kind, LOCAL_EXTRACTION_KINDS, ""),
    title,
    dueDate: str(raw.dueDate).slice(0, 40),
    person: str(raw.person).slice(0, 80),
    project: str(raw.project).slice(0, 80),
    priority: oneOf(raw.priority, LOCAL_EXTRACTION_PRIORITIES, ""),
    recurrence: oneOf(raw.recurrence, LOCAL_EXTRACTION_RECURRENCE, "none"),
    confidence: oneOf(raw.confidence, ["high", "medium", "low"], "medium"),
    ambiguous: str(raw.ambiguous).slice(0, 200),
  };
}

async function requestLocalExtraction(text, today) {
  const reply = await localModelComplete(
    [{ role: "user", content: buildLocalExtractionPrompt(text, today) }],
    { json: true },
  );
  if (!reply) return null;
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
  const items = list.map(cleanLocalExtractionItem).filter(Boolean).slice(0, 8);
  if (!items.length) return null;
  // Same shape the server returns, so mergeExtractions does not need to know which path ran.
  return { ...items[0], items };
}

/* Asks the configured model for a structured read of the sentence. Returns null on any failure
   or when no provider is configured — the local result is already applied, so a failure here
   costs the refinement and nothing else. */
async function requestModelExtraction(text) {
  if (isFileProtocol()) return null;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // Local first: it is free, and on a phone-sized budget a quota is worth spending last.
  const local = await requestLocalExtraction(String(text).slice(0, 2000), today);
  if (local) return local;
  try {
    const res = await apiFetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "extract",
        text: String(text).slice(0, 2000),
        today,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.extraction) return null;
    // An older build ignores `items` and keeps the one-item behaviour.
    return {
      ...data.extraction,
      items: Array.isArray(data.items) ? data.items : [],
    };
  } catch (error) {
    return null;
  }
}

/* Folds the model's reading into the local one. The model only wins on fields it actually
   filled and only when the rules were unsure; a confident local read is never overwritten,
   and a value the model left empty never erases one the rules found. */
function mergeExtractions(local, ai) {
  const merged = { ...local };
  const preferModel = local.confidence !== "high";
  for (const field of [
    "kind",
    "dueDate",
    "person",
    "project",
    "priority",
    "recurrence",
    "ambiguous",
  ]) {
    const value = ai?.[field];
    if (value === undefined || value === null || value === "") continue;
    if (preferModel || !merged[field]) merged[field] = value;
  }
  merged.confidence = ai?.confidence || local.confidence;
  // A clear title from the model is the single biggest readability win, so use it when present.
  if (ai?.title && (preferModel || !merged.title)) merged.title = ai.title;
  merged.aiUsed = true;
  return merged;
}
function closeCapture() {
  stopVoiceDictation();
  // The answer recogniser is separate, so it is not covered by the line above and has to be told
  // explicitly, or it would keep the microphone open behind a closed sheet.
  stopCaptureAnswerDictation();
  resetCaptureDialogue();
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  document.getElementById("captureModal").classList.remove("open");
  lockPageScroll(false);
}
async function saveCapture(forceSave = false, options = {}) {
  if (captureSaveInFlight) return false;
  // A manual Save supersedes any pending "Done.", so it can never fire a moment later.
  cancelAutoSave();
  const kind = captureType;
  // Media handling follows the *channel*. A dictated "call Ravi tomorrow" that has been read as a
  // task is still a voice note, and must still upload its audio and keep its transcript; deciding
  // that from `kind` is what used to force the smart-capture rules to skip every media capture.
  const channel = captureChannel;
  const isMediaType = ["voice", "image", "file"].includes(channel);
  const isLink = channel === "link";
  const text = isLink
    ? document.getElementById("linkUrlInput").value.trim()
    : document.getElementById("captureText").value.trim();

  if (channel === "voice" && !pendingBlob && !text) {
    setVoiceDictationStatus("Record audio or dictate a note before saving.");
    return false;
  }
  if (["image", "file"].includes(channel) && !pendingBlob) {
    setVoiceDictationStatus("Choose a file before saving.");
    return false;
  }
  if (!isMediaType && !text) return false;

  if (isLink) {
    try {
      const url = new URL(text.match(/^https?:\/\//i) ? text : `https://${text}`);
      if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported protocol");
    } catch (error) {
      const hint = document.getElementById("captureHint");
      if (hint) hint.textContent = "Enter a valid http or https link before saving.";
      document.getElementById("linkUrlInput")?.focus();
      return false;
    }
  }

  const realKind = kind === "text" ? "memory" : kind;
  const candidateTitle = isMediaType
    ? channel === "voice"
      ? text || "Voice note"
      : channel === "image"
        ? text || pendingBlob?.name || "Image"
        : pendingBlob?.name || "File"
    : isLink
      ? text
      : text;
  // A capture that saves itself made the raw sentence the title of every meeting and task, which
  // reads badly in a list. The reading already returns a clean one, so use it for work — but not
  // for a note, a link or media, where the person's own words are the point. rawText keeps the
  // original sentence either way, so nothing is lost.
  const title = CAPTURE_MODEL_TITLE_KINDS.has(realKind)
    ? String(captureExtraction?.title || "").trim().slice(0, 200) ||
      // No model, so the reading has no title of its own. The date and time live in their own field
      // and the wrapper is just how the reminder was phrased, so neither belongs in the title.
      (REMINDER_INTENT_RE.test(text) ? cleanReminderTitle(text) : "") ||
      candidateTitle
    : candidateTitle;
  // Checked against the title that will actually be stored, so the fingerprint and the warning
  // can never disagree about what "the same capture" means.
  if (!forceSave && updateCaptureDuplicate(realKind, title)) {
    document.getElementById("captureDuplicateWarning")?.scrollIntoView({ block: "nearest" });
    return false;
  }

  captureSaveInFlight = true;
  const saveButton = document.getElementById("captureSaveBtn");
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
  }
  try {
    let mediaUrl = null;
    if (isMediaType && pendingBlob) mediaUrl = await uploadPendingBlob();

    const project = document.getElementById("captureProject").value;
    const dueVal = document.getElementById("captureDueDate").value;
    const dueISO = dueVal ? new Date(dueVal).toISOString() : "";
    const recurrence = document.getElementById("captureRecurrence").value;
    const priority =
      document.getElementById("capturePriority").value ||
      (kind === "task" ? "medium" : "");
    const person = document.getElementById("capturePerson").value.trim();
    const captionText = document.getElementById("captureText").value.trim();
    const sourceType = isLink ? "link" : isMediaType ? channel : "manual";
    const sub = isMediaType
      ? channel === "voice"
        ? captionText ? "Voice note" : "Voice"
        : channel === "image"
          ? captionText ? "Image" : ""
          : "File"
      : isLink
        ? captionText || "Link"
        : kind === "task"
          ? "Captured task"
          : kind === "event"
            ? "Captured event"
            : kind === "waiting"
              ? "Waiting for"
              : kind === "openloop"
                ? "Open loop"
                : "Memory";
    const captureMetadata = {
      ...(captureExtraction || {}),
      smartEnabled: captureSmartEnabled,
      source: captureExtraction?.source || "manual",
      transcript: channel === "voice" && captureVoiceFinal ? captureVoiceFinal : undefined,
      // Which language was actually dictated, so a transcript can be read back correctly later.
      language: channel === "voice" && captureVoiceLanguage ? captureVoiceLanguage : undefined,
      // Text read out of a picture, kept so the original recognition is auditable.
      ocrText: channel === "image" && imageOcrText ? imageOcrText : undefined,
      ocrLanguage: channel === "image" && imageOcrText ? captureOcrLang : undefined,
      mediaName: pendingBlob?.name || undefined,
    };
    Object.keys(captureMetadata).forEach((key) => captureMetadata[key] === undefined && delete captureMetadata[key]);
    const newItem = {
      id: cid(),
      ownerId: sbUser || currentUserId || null,
      kind: realKind,
      title,
      sub,
      priority,
      person,
      due: dueISO ? formatDueDisplay(dueISO) : kind === "task" ? "Today" : "",
      dueDate: dueISO,
      recurrence,
      status: kind === "task" ? "today" : "inbox",
      project,
      created: Date.now(),
      done: false,
      scope: captureScope,
      mediaUrl: mediaUrl || "",
      sourceType,
      rawText: text || title,
      captureMetadata,
      captureFingerprint: CAPTURE_GENERIC_TITLES.has(normaliseCaptureFingerprint(title)) ? null : captureFingerprintFor(realKind, title),
    };

    // Document fields. Read only for a document, and the expiry falls back to the value the image
    // choice read out of the picture, so "Keep as document" on a photographed warranty saves with
    // its expiry without anyone touching a field.
    if (realKind === "document") {
      const read = (id) => (document.getElementById(id)?.value || "").trim();
      const expires = read("captureDocExpires") || captureDocExpiry;
      newItem.docType = read("captureDocType");
      newItem.issuer = read("captureDocIssuer");
      newItem.docNumber = read("captureDocNumber");
      newItem.issuedOn = read("captureIssuedOn");
      // Validated here as well as on read: an expiry the browser's date input cannot produce could
      // still arrive from an imported backup, and it would sort as "no expiry" without complaint.
      newItem.expiresOn = parseIsoDate(expires) ? expires : "";
      // A document is not a task, so it must not nag as one on the day it was captured.
      newItem.dueDate = "";
      newItem.due = "";
      newItem.status = "inbox";
    }

    // Money fields. The amount is parsed to integer paise here and nowhere else, so there is exactly
    // one place a float could ever enter the app — and it does not.
    if (realKind === "expense") {
      const read = (id) => (document.getElementById(id)?.value || "").trim();
      // Falls back to the sentence, so "Spent ₹450 for groceries" saves its amount without anyone
      // touching the box. The typed value wins when both are present: a correction is a decision.
      const typed = read("captureAmount");
      const minor = parseMoneyToMinor(typed) ?? parseAmountFromText(text);
      const spentOn = read("captureSpentOn");
      const category = read("captureCategory") || guessMoneyCategory(text || title);
      if (minor !== null && minor > 0) {
        captureMetadata.amountMinor = minor;
        captureMetadata.currency = MONEY_CURRENCY;
        captureMetadata.category = category;
        captureMetadata.merchant = read("captureMerchant");
        // A date the picker cannot produce is dropped rather than stored; the report falls back to
        // the created timestamp, which is what it would have used anyway.
        // A date the *reader* found is the day the money was spent, so it is taken from the due date
        // the parse already produced. "Spent ₹450 on Monday" belongs to Monday, and it must not then
        // be left on the Schedule as something to do on Monday.
        const fromPicker = parseIsoDate(spentOn) ? spentOn : "";
        const fromSentence = dueISO && !isNaN(new Date(dueISO).getTime()) ? isoDateString(new Date(dueISO)) : "";
        captureMetadata.spentOn = fromPicker || fromSentence || "";
      }
      // An expense is money already spent. It has no due date, so it must never appear on the
      // Schedule as something to do, and must never fire a reminder.
      newItem.dueDate = "";
      newItem.due = "";
      newItem.status = "inbox";
      newItem.sub = newItem.sub || (minor !== null && minor > 0 ? formatMoney(minor) : "");
    }

    // Money owed. The amount lives under its own key, never `amountMinor`, so a month total that
    // walks every item cannot count a debt as spending. And the row is a task, so it lands on Today
    // and can be completed when the money actually arrives.
    if (realKind === "task" && textLooksLikeMoneyOwed(text || title)) {
      const owed = parseAmountFromText(text || title);
      if (owed !== null && owed > 0) {
        captureMetadata.owedMinor = owed;
        captureMetadata.currency = MONEY_CURRENCY;
        captureMetadata.owedDirection = moneyOwedDirection(text || title);
        if (!newItem.sub) newItem.sub = formatMoney(owed);
      }
    }

    // A bill is money still owed. It keeps its due date — that is the whole point of it — and so it
    // is the one money kind that DOES reach the Schedule and DOES fire a reminder.
    if (realKind === "bill") {
      const read = (id) => (document.getElementById(id)?.value || "").trim();
      const minor = parseMoneyToMinor(read("captureBillAmount")) ?? parseAmountFromText(text);
      if (minor !== null && minor > 0) {
        captureMetadata.amountMinor = minor;
        captureMetadata.currency = MONEY_CURRENCY;
        captureMetadata.billType = read("captureBillType") === "subscription" ? "subscription" : "bill";
        captureMetadata.merchant = read("captureBillMerchant");
      }
      // The picker is the better date: it is a whole day, while the sentence's parse carries a time
      // of day that would fire the reminder at whatever hour the sentence happened to imply.
      const picked = read("captureBillDue");
      if (parseIsoDate(picked)) {
        const noon = new Date(picked + "T12:00:00");
        newItem.dueDate = Number.isNaN(noon.getTime()) ? newItem.dueDate : noon.toISOString();
        newItem.due = fmtDate(picked);
      }
      // Monthly unless the person chose otherwise, which is what the sheet pre-selects anyway.
      if (!newItem.recurrence || newItem.recurrence === "none") newItem.recurrence = "monthly";
      newItem.status = "planned";
      newItem.sub = newItem.sub || (minor !== null && minor > 0 ? formatMoney(minor) : "");
    }

    // An expense without an amount is a capture that says "I spent money" and records how much:
    // unknown. The Money view shows a dash and the month total silently under-counts, which is the
    // one failure in this module that nobody would notice. So it is refused here, before the item is
    // created. The sheet deliberately stays open with the sentence intact, because the answer is one
    // number and closing would make the person type the whole thing again.
    if (realKind === "expense" && !newItem.captureMetadata.amountMinor) {
      const amountField = document.getElementById("captureAmount");
      const hint = document.getElementById("captureHint");
      if (hint) hint.textContent = "Enter how much was spent, e.g. 450 or ₹450.";
      if (amountField) {
        amountField.focus();
        amountField.select?.();
      }
      return false;
    }

    // Agenda lines ride along as the main item's checklist, not as extra rows to triage.
    if (captureAgenda.length) {
      newItem.checklist = normaliseChecklist([
        ...normaliseChecklist(newItem.checklist),
        ...captureAgenda.map((entry) => ({ text: entry.title, done: false })),
      ]);
    }

    state.items.unshift(newItem);
    closeCapture();
    await dbSaveItem(newItem);

    // Saved after the first item so planOf can point at it, one at a time so a mid-way
    // failure cannot leave the group half-written while the screen claims success.
    const created = [newItem];
    for (const extra of buildCapturePlanItems(newItem)) {
      state.items.unshift(extra);
      created.push(extra);
      await dbSaveItem(extra);
    }
    // Only an auto-create is silent, so only an auto-create has to be reversible.
    if (options.auto) showCaptureUndo(created);
    return created;
  } catch (error) {
    console.error("Capture save failed:", error);
    const hint = document.getElementById("captureHint");
    if (hint) hint.textContent = "Could not save this capture. Please try again.";
    return false;
  } finally {
    captureSaveInFlight = false;
    if (saveButton) {
      saveButton.disabled = false;
      updateCaptureSaveLabel();
    }
  }
}
async function quickCapture() {
  const input = document.getElementById("quickRemember");
  const text = input.value.trim();
  if (!text) return;
  const newItem = {
    id: cid(),
    kind: "memory",
    title: text,
    sub: "Memory",
    priority: "",
    person: "",
    due: "",
    status: "inbox",
    project: "",
    created: Date.now(),
    done: false,
    scope: "shared",
  };
  state.items.unshift(newItem);
  input.value = "";
  await dbSaveItem(newItem);
}
async function startNudge() {
  const newItem = {
    id: cid(),
    kind: "task",
    title: "Work on business idea",
    sub: "20-minute focus block",
    priority: "medium",
    person: "",
    due: "Today",
    status: "today",
    project: "",
    created: Date.now(),
    done: false,
  };
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  switchView("tasks");
}

function dismissNudge() {
  const today = new Date().toISOString().slice(0, 10);
  localStorage.setItem("everything_nudge_dismissed", today);
  const card = document.getElementById("nudgeCard");
  if (card) card.style.display = "none";
}

function restoreNudge() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem("everything_nudge_dismissed") !== today) return;
  const card = document.getElementById("nudgeCard");
  if (card) card.style.display = "none";
}
