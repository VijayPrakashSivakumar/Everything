/* ---------- Keyboard shortcuts ---------- */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/* Modals and the Ask overlay block the single-letter shortcuts; the item slide-over
   does not — a quick capture from there just closes it first. */
/* ---------- History-aware back navigation ----------

   The problem: this app never changed the URL, so the browser's back gesture had nothing to
   return to. Swiping back from Tasks left the app, and from inside a sheet it left the app too.

   The model is a real history stack, which is the approach a router would use:

     entry  { everything: 1, ev: "today" }              the view
     entry  { everything: 1, ev: "tasks", layer: "nav" } a layer opened on top of it

   Every layer gets its own entry, so nested layers unwind one at a time, and every view the
   person navigates to gets one, so back walks the views in reverse. A back press is delivered as
   popstate, and the handler reconciles the screen to whatever entry the browser landed on.

   A web page cannot close its own tab, so once the stack is empty the browser is at its real
   entry and back does what the platform does — background the app. Holding a permanent guard
   instead would trap people on the site with no way out, which is worse than the problem. */
const navState = { layers: [], reconciling: false };

/* ---------- Dialog focus and the background ----------
   What this fixes: pressing Tab inside an open sheet walked straight out of it into the page behind,
   and closing the sheet dropped focus on <body>, which dumps a keyboard user at the top of the
   document with nothing to say where they were. Four of the five overlays were also not marked as
   dialogs at all, so a screen reader read the page as though no sheet were on top of it.

   The earlier attempt at this kept its own stack of open layers, pushed on open and popped on close.
   That is the shape that breaks: every close path has to remember to pop, and one that forgets leaves
   the entire app marked inert — frozen, unclickable, with no way back. It did exactly that here.

   So there is no list. Which dialogs are open is read from the DOM every time it is needed, and the
   existing MutationObserver that already watches class changes for the back button calls
   syncDialogBackground() whenever one opens or closes. A close path that forgets to do anything at
   all therefore needs no recovery: the element is no longer `.open`, the next sync sees that, and
   the app comes back. Nothing to forget means nothing can be forgotten.

   Where focus came from is kept in a WeakMap keyed by the dialog. Keyed, not stacked: a WeakMap has
   no ordering to get wrong, and an entry for an element that has left the DOM is collected on its
   own instead of being left behind. */
const OPEN_DIALOGS = ".modal-overlay.open, .ask-overlay.open";
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", '[tabindex]:not([tabindex="-1"])',
].join(",");

const focusBeforeDialog = new WeakMap();

function openDialogs() {
  return Array.from(document.querySelectorAll(OPEN_DIALOGS));
}

/* Body children rather than a named container: the sheets are siblings of the app shell, so naming
   one would hard-code the page structure and miss anything added later. */
function syncDialogBackground() {
  const open = openDialogs();
  const top = open.length ? open[open.length - 1] : null;
  for (const child of Array.from(document.body.children)) {
    if (child.tagName === "SCRIPT") continue;
    child.inert = Boolean(top) && !(child === top || child.contains(top));
  }
}

function dialogFocusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.disabled);
}

function enterDialog(el, initialFocusId) {
  if (!el) return;
  // Only recorded once, so a re-render of the same open sheet does not overwrite the element the
  // person was actually standing on.
  if (!focusBeforeDialog.has(el)) focusBeforeDialog.set(el, document.activeElement);
  syncDialogBackground();
  const target = initialFocusId
    ? el.querySelector(`#${initialFocusId}`)
    : dialogFocusables(el)[0];
  if (!target) return;
  // After paint, or the scroll lock and the caret fight each other. Re-checked at that point,
  // because a sheet opened and closed inside one frame must not leave focus on a hidden element.
  requestAnimationFrame(() => {
    if (el.classList.contains("open")) target.focus();
  });
}

function leaveDialog(el) {
  // Read the DOM first, so this is also the recovery path for a close that never called it.
  syncDialogBackground();
  if (!el) return;
  const was = focusBeforeDialog.get(el);
  focusBeforeDialog.delete(el);
  // Never hand focus to <body>. If nothing was focused before the dialog opened, the honest answer is
  // the first real control on the page, not the top of the document — which is where a keyboard user
  // ends up otherwise, with no idea what happened.
  if (!was || was === document.body || !was.isConnected) {
    const first = document.querySelector(FOCUSABLE);
    if (first && !first.closest(".modal-overlay, .ask-overlay")) first.focus();
    return;
  }
  was.focus();
}

/* Tab loops inside the topmost dialog. `inert` already keeps the keyboard out of the background; this
   closes the remaining gap, where Tab off the last control walks out through the browser chrome and
   back in again, losing the place and — on a long page — landing far from where the person was. */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const open = openDialogs();
  if (!open.length) return;
  const top = open[open.length - 1];
  if (!top.contains(document.activeElement)) return;
  const items = dialogFocusables(top);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

/* The view recorded is the one the entry represents, passed explicitly. Reading `activeView`
   here would store the view being *left*, so back would always land one step too far. */
function navEntry(layer, view) {
  return { everything: 1, ev: view || activeView, layer: layer || null };
}

function navSafe(fn, fallback) {
  try {
    fn();
    return true;
  } catch (e) {
    // No history available (private mode, sandboxed frame). The layer still opens and closes;
    // only the back gesture is unavailable, which is the platform's own behaviour.
    return fallback;
  }
}

function navPushView(id) {
  return navSafe(() => history.pushState(navEntry(null, id), ""), false);
}

function navReplaceView(id) {
  return navSafe(() => history.replaceState(navEntry(null, id), ""), false);
}

function navPushLayer(name) {
  navState.layers.push(name);
  return navSafe(() => history.pushState(navEntry(name), ""), false);
}

/* Called when a layer closed itself, and by the observer when a view change closed one for it.
   Going "back" rather than dropping the entry keeps the browser's position and ours in step.

   Only valid while the current entry really is the layer's own. A view change from inside a layer —
   a sidebar nav tap — pushes a view entry above the layer's, so unwinding would walk onto the layer
   marker instead, whose `ev` is the view the person came from; popstate would then treat that marker
   as a destination and switch them straight back, which is what made the menu look dead. The
   layer's entry is gone by then, so drop the bookkeeping and hold position. */
function navPopLayer() {
  const top = navState.layers[navState.layers.length - 1];
  if (top === undefined) return;
  navState.layers.pop();
  const current = history.state;
  if (current && current.everything && current.layer === top) {
    navSafe(() => history.back(), false);
  }
}

/* The innermost dismissible thing on screen, or null. Order is by stacking, not document order:
   a sheet opened from a panel is above the panel, and a menu is below both. */
function topmostOpenLayer() {
  const open = (id, cls) => {
    const el = document.getElementById(id);
    return el && (cls ? el.classList.contains(cls) : !el.hidden);
  };
  if (document.querySelector(".modal-overlay.open")) return "modal";
  if (open("askOverlay", "open")) return "ask";
  if (open("panel", "open")) return "panel";
  if (open("sidebar", "open")) return "sidebar";
  if (open("searchDropdown", null)) return "search";
  return null;
}

function initBackNavigation() {
  // The entry this app opened on, so the first back press is not mistaken for leaving.
  navReplaceView(activeView);

  /* Drive the stack from what is actually on screen rather than from each open/close call site.
     That way every existing path — buttons, Escape, save-and-close, the slide-over, the menus —
     is covered without touching any of them, and a layer opened from inside another layer
     correctly pushes a second entry instead of reusing the first. */
  const observer = new MutationObserver(() => {
    /* Keep the background in step with what is actually on screen, before anything else. This is the
       whole reason the dialog code has no list of open layers: a sheet that closes without telling
       anyone still drops its `.open` class, this runs anyway, and the app unfreezes. A close path that
       forgets to do anything is therefore not a failure mode — it is just a close. */
    syncDialogBackground();
    if (navState.reconciling) return;
    const open = topmostOpenLayer();
    const stack = navState.layers;
    if (open) {
      const at = stack.indexOf(open);
      // Not tracked yet: a new layer, so it needs its own entry.
      if (at === -1) {
        navPushLayer(open);
        return;
      }
      // Tracked but not on top: layers beneath it closed in one go (Escape, a save that closed
      // a sheet and its parent). Unwind to match rather than pushing a duplicate.
      while (stack.length > at + 1) navPopLayer();
    } else {
      while (stack.length) navPopLayer();
    }
  });
  observer.observe(document.body, {
    attributes: true,
    subtree: true,
    childList: true,
    attributeFilter: ["class", "hidden"],
  });

  window.addEventListener("popstate", (event) => {
    // The browser already consumed whatever entry it was on. Whatever is still open is
    // therefore one level too deep, and closing it is the whole job of this press.
    navState.reconciling = true;
    try {
      const state = event.state && event.state.everything ? event.state : null;
      if (navState.layers.length) {
        navState.layers.pop();
        closeTopmostOverlay();
      }
      // Then put the view back. Done without pushing, because the browser owns the position now.
      if (state && state.ev && state.ev !== activeView) switchView(state.ev, { history: "none" });
    } finally {
      navState.reconciling = false;
    }
  });

  // Tapping outside the search field dismisses its dropdown.
  document.addEventListener("pointerdown", (e) => {
    const dd = document.getElementById("searchDropdown");
    if (!dd || dd.hidden) return;
    if (dd.contains(e.target)) return;
    if (e.target.closest("#searchBox")) return;
    closeSearch();
  });
}

function isBlockingOverlayOpen() {
  return (
    !!document.querySelector(".modal-overlay.open") ||
    document.getElementById("askOverlay").classList.contains("open")
  );
}

/* Closes the top-most thing that is open. Returns true if it closed something. */
function closeTopmostOverlay() {
  // The confirm dialog is above everything, because it is the thing you were asked to decide. Escape
  // and the hardware back button both land here, so it has to be first: settleConfirmDialog() both
  // removes the .open class and resolves the promise, and without this branch the generic modal
  // checks below would never run — but a caller awaiting a promise that nothing settles hangs forever,
  // and a delete that hangs halfway through is worse than one that never started.
  if (document.getElementById("confirmDialog")?.classList.contains("open")) {
    settleConfirmDialog(false);
    return true;
  }

  const notif = document.getElementById("notifPanel");
  if (notif && notif.style.display === "block") {
    notif.style.display = "none";
    return true;
  }

  const avatar = document.getElementById("avatarMenu");
  if (avatar && avatar.style.display === "block") {
    avatar.style.display = "none";
    return true;
  }

  if (document.getElementById("sidebar")?.classList.contains("open")) {
    closeSidebar();
    return true;
  }

  if (document.getElementById("searchDropdown") && !document.getElementById("searchDropdown").hidden) {
    closeSearch();
    return true;
  }

  // The palette reuses the .ask-overlay class so it inherits the styling, which means the generic
  // "is an ask overlay open" check below would match it and Escape would close Ask instead. The
  // palette is checked first so it always wins.
  if (document.getElementById("commandPalette")?.classList.contains("open")) {
    closeCommandPalette();
    return true;
  }
  if (document.getElementById("askOverlay")?.classList.contains("open")) {
    closeAsk();
    return true;
  }
  if (document.getElementById("editModal").classList.contains("open")) {
    closeEditModal();
    return true;
  }
  if (document.getElementById("personModal").classList.contains("open")) {
    closePersonModal();
    return true;
  }
  if (document.getElementById("captureModal").classList.contains("open")) {
    closeCapture();
    return true;
  }
  if (document.getElementById("panel").classList.contains("open")) {
    closePanel();
    return true;
  }

  return false;
}

function shortcutsModifierLabel() {
  const isApple =
    /mac|iphone|ipad|ipod/i.test(navigator.platform || "") ||
    /mac os x/i.test(navigator.userAgent || "");
  return isApple ? "⌘ K" : "Ctrl K";
}

function initShortcuts() {
  const hint = document.getElementById("searchKbdHint");
  if (hint) hint.textContent = shortcutsModifierLabel();

  document.addEventListener("keydown", (e) => {
    const key = e.key;

    if (key === "Escape") {
      if (closeTopmostOverlay()) e.preventDefault();
      return;
    }

    const modifier = e.metaKey || e.ctrlKey;

    if (modifier && (key === "k" || key === "K")) {
      e.preventDefault();
      // Ctrl+Shift+K is the palette; plain Ctrl+K stays with Ask. One key, two behaviours, is how
      // a shortcut becomes a coin flip — and Ask is the older, documented one.
      if (e.shiftKey) openCommandPalette();
      else openAsk();
      return;
    }

    if (isTypingTarget(e.target) || modifier || e.altKey) return;

    if (key === "/") {
      e.preventDefault();
      openAsk();
      return;
    }

    if (key === "c" || key === "C") {
      e.preventDefault();
      if (isBlockingOverlayOpen()) return;
      if (document.getElementById("panel").classList.contains("open"))
        closePanel();
      openCapture();
    }
  });
}

/* ---------- Backup: export / import ---------- */
function exportData() {
  const payload = {
    app: "everything",
    version: 1,
    exportedAt: new Date().toISOString(),
    items: state.items || [],
    projects: state.projects || [],
    goals: state.goals || [],
    people: state.people || [],
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `everything-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFileAsText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importData(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await readFileAsText(file));
  } catch (e) {
    await alertDialog({ title: "That file is not JSON", body: "Nothing was imported. Pick a file exported from Everything." });
    input.value = "";
    return;
  }

  const incomingItems = Array.isArray(payload.items) ? payload.items : [];
  const incomingProjects = Array.isArray(payload.projects)
    ? payload.projects
    : [];
  const incomingGoals = Array.isArray(payload.goals) ? payload.goals : [];
  const incomingPeople = Array.isArray(payload.people) ? payload.people : [];

  if (
    !incomingItems.length &&
    !incomingProjects.length &&
    !incomingGoals.length &&
    !incomingPeople.length
  ) {
    await alertDialog({ title: "No Everything data in that file", body: "The file parsed, but it holds no captures. Nothing was imported." });
    input.value = "";
    return;
  }

  const ok = await confirmDialog({
    title: `Import ${incomingItems.length} item${incomingItems.length === 1 ? "" : "s"}?`,
    body: "Anything already here with the same id is replaced, not merged. Export first if you might want the current version back.",
    confirmLabel: "Import",
    danger: true,
  });
  if (!ok) {
    input.value = "";
    return;
  }

  state.items = state.items || [];
  state.projects = state.projects || [];
  state.goals = state.goals || [];
  state.people = state.people || [];

  for (const item of incomingItems) {
    if (!item || !item.id) continue;
    // Imported JSON is user-supplied, so give it the same defaulting the rest of the app does.
    // Without this, one item with no kind left Today unable to render at all.
    if (!item.kind) item.kind = "text";
    const existing = state.items.find((i) => i.id === item.id);
    if (existing) Object.assign(existing, item);
    else state.items.unshift(item);
    await dbSaveItem(item);
  }
  for (const p of incomingProjects) {
    if (!p || !p.id) continue;
    if (!state.projects.some((x) => x.id === p.id)) state.projects.unshift(p);
    await dbSaveProject(p);
  }
  for (const g of incomingGoals) {
    if (!g || !g.id) continue;
    if (!state.goals.some((x) => x.id === g.id)) state.goals.unshift(g);
    await dbSaveGoal(g);
  }
  for (const p of incomingPeople) {
    if (!p || !p.id) continue;
    if (!state.people.some((x) => x.id === p.id)) state.people.unshift(p);
    await dbSavePerson(p);
  }

  input.value = "";
  renderAll();
    await alertDialog({ title: "Import finished", body: `${incomingItems.length} item${incomingItems.length === 1 ? "" : "s"} imported.` });
}

/* PWA manifest shortcuts / deep links: ./?capture=1 and ./?view=tasks */
function applyLaunchShortcut() {
  if (!state || !location.search) return;

  const params = new URLSearchParams(location.search);
  const view = params.get("view");

  if (view && document.getElementById("view-" + view)) switchView(view);

  if (params.get("capture") === "1") openCapture();
}

/* ---------- share target ----------

   Asks the service worker for anything that was shared into the app. The worker deletes it as it
   replies, so this is single-use: a reload finds nothing and leaves the capture sheet alone. */
async function readSharedCapture() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await serviceWorkerRegistration();
  if (!reg || !reg.active) return null;

  const channel = new MessageChannel();
  const reply = new Promise((resolve) => {
    channel.port1.onmessage = (event) => resolve(event.data || null);
  });
  try {
    reg.active.postMessage({ type: "READ_SHARE" }, [channel.port2]);
  } catch (e) {
    return null;
  }
  // A worker that never answers must not leave the app waiting forever.
  return Promise.race([reply, new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
}

/* Shared text is captured, not just filed.

   This deliberately goes through onCaptureInput() — the same entry point as typing and dictation —
   so a sentence shared from a message is *read* exactly like one you typed: "Call Ravi tomorrow"
   arrives as a task with a person and a date, not as a wall of text in the inbox. Routing it
   anywhere else would make sharing a second-class way to capture, which is the whole point of it. */
async function applySharedCapture() {
  if (!new URLSearchParams(location.search).has("share")) return;

  const shared = await readSharedCapture();
  if (!shared || !shared.combined) return;

  if (syncReadyPromise) {
    try {
      await syncReadyPromise;
    } catch (e) {
      /* The capture sheet still works without the data layer. */
    }
  }

  openCapture();
  const input = document.getElementById("captureText");
  if (!input) return;

  input.value = shared.combined;
  onCaptureInput();
  setCaptureHint(
    icon("share-2") +
      (shared.imageCount
        ? ` Shared from another app${shared.imageCount > 1 ? ` with ${shared.imageCount} images` : ""}.`
        : " Shared from another app."),
  );
  if (shared.url) {
    // A shared page is a link, and links are captured in their own field, validated as URLs.
    const linkInput = document.getElementById("linkUrlInput");
    if (linkInput) linkInput.value = shared.url;
  }
  if (shared.imageCount) {
    setVoiceDictationStatus(
      "An image was shared too. Choose it below to read its text and add it to this capture.",
    );
  }
}

/* ---------- Theme ----------

   Two independent axes. `data-theme` keeps its original light/dark meaning and every rule that
   reads it is unchanged; the visual concept lives on `data-concept` and only overrides design
   tokens. `default` has no CSS at all, so nothing looks different until a concept is chosen.

   `data-scheme` is the resolved light/dark value, always written explicitly. Having it as an
   attribute is what lets a concept be scoped to one scheme with a plain selector, instead of
   needing the OS media query and an explicit choice to be reconciled by specificity. */
/* The whole theme list. Adding a concept is one entry here plus one block of CSS: the swatch colours
   live on the entry so they cannot drift away from the theme they describe. */
const APP_THEMES = [
  { id: "default", label: "Default", hint: "The original look", swatch: ["#f5f6fb", "#4361ee", "#10152b", "#ffffff"] },
  { id: "premium", label: "Premium", hint: "Warm, refined, unhurried", swatch: ["#faf9f7", "#8a6d3b", "#1c1917", "#ffffff"] },
  { id: "focus", label: "Deep Work", hint: "Flat, square, still", swatch: ["#fbfbfa", "#3f4a55", "#ffffff", "#e5e5e1"] },
  { id: "casual", label: "Casual", hint: "Round, soft, relaxed", swatch: ["#fdf7f4", "#e2725b", "#2d2a3b", "#ffffff"] },
  { id: "aurora", label: "Aurora", hint: "Gradient and glass", swatch: ["#f3f1fd", "#6d3bf5", "#2a1a5e", "#d8ccff"] },
  { id: "editorial", label: "Editorial", hint: "Serif, paper, quiet", swatch: ["#f7f4ec", "#9a3f2d", "#f4efe4", "#fffdf8"] },
  { id: "dense", label: "Dense", hint: "Monospace, compact, fast", swatch: ["#f2f4f7", "#0b6bcb", "#101720", "#dbe0e7"] },
  { id: "sage", label: "Sage", hint: "Botanical, calm, natural", swatch: ["#f3f6f2", "#4a7c59", "#1e2a22", "#ffffff"] },
  { id: "bordeaux", label: "Bordeaux", hint: "Deep wine, rich and warm", swatch: ["#faf5f4", "#8e2f4a", "#2a1119", "#ffffff"] },
  { id: "rose", label: "Rose", hint: "Soft, airy, elegant", swatch: ["#fbf6f7", "#b5677f", "#2e2430", "#ffffff"] },
];
const THEME_STATE_KEY = "themeConcept";
const themeSchemeMedia =
  typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function isKnownTheme(id) {
  return APP_THEMES.some((theme) => theme.id === id);
}

function currentThemeConcept() {
  const id = document.documentElement.getAttribute("data-concept");
  return isKnownTheme(id) ? id : "default";
}

/* Mirrors data-scheme onto the resolved scheme, so a concept can pick its own palette for light
   and dark without caring whether dark came from the OS or from an explicit choice. */
function syncThemeScheme() {
  const stored = document.documentElement.getAttribute("data-theme");
  const scheme = stored === "dark" || stored === "light" ? stored : themeSchemeMedia && themeSchemeMedia.matches ? "dark" : "light";
  if (document.documentElement.getAttribute("data-scheme") !== scheme)
    document.documentElement.setAttribute("data-scheme", scheme);
}

function applyThemeConcept(id) {
  const concept = isKnownTheme(id) ? id : "default";
  document.documentElement.setAttribute("data-concept", concept);
  syncThemeScheme();
  renderThemePicker();
}

function setThemeConcept(id) {
  if (!isKnownTheme(id)) return;
  applyThemeConcept(id);
  if (state) {
    state[THEME_STATE_KEY] = id;
    save();
  }
  try {
    localStorage.setItem("everything_theme_concept", id);
  } catch (e) {
    /* Private mode: the choice still applies for this session. */
  }
}

function initTheme() {
  if (themeSchemeMedia && typeof themeSchemeMedia.addEventListener === "function")
    themeSchemeMedia.addEventListener("change", syncThemeScheme);
  applyThemeConcept(currentThemeConcept());
}

/* ---------- Inline help ----------

   One delegated listener for every `.info-tip` on the page, so a tip added later needs no wiring
   and the capture sheet — which is rebuilt constantly — does not need rebinding.

   Three ways to open (hover on a pointer device, focus from the keyboard, tap anywhere) and three
   ways to close (pointer leaving, blur, Escape or a tap elsewhere). The tap case is the one that
   matters: this app is mostly opened on a phone, where `mouseenter` never fires. */
let infoTipSeq = 0;

function infoTipMarkup(text) {
  const id = `tip-${++infoTipSeq}`;
  // The text lives in the bubble and nowhere else, so there is one source of truth and the button
  // stays empty for a screen reader to announce through aria-describedby rather than twice.
  return `<button type="button" class="info-tip" aria-expanded="false" aria-describedby="${id}">`
    + `<span class="info-tip__bubble" id="${id}" role="tooltip" aria-hidden="true">${escapeHtml(text)}</span>`
    + `</button>`;
}

// The bubble hangs above by default and below when there is no room, because the capture sheet
// opens over the bottom of a phone screen where an upward bubble would be clipped by it. It is also
// nudged sideways: the sheet puts Repeats in the right-hand column of a two-up grid, so a bubble
// centred on the dot runs straight off a 390px screen.
function positionTip(tip) {
  if (!tip) return;
  const bubble = tip.querySelector(".info-tip__bubble");
  if (!bubble) return;
  tip.classList.remove("below");
  const box = tip.getBoundingClientRect();
  const height = bubble.offsetHeight || 70;
  const width = bubble.offsetWidth || 200;
  // No room above the dot but some below: flip rather than render off-screen.
  if (box.top - height - 16 < 0) tip.classList.add("below");

  // Shift so the bubble stays inside the viewport, but never so far that it detaches from its dot
  // — past halfway the bubble is further from the dot than from the screen edge, so clamp there.
  const margin = 8;
  const overflowRight = box.left + box.width / 2 + width / 2 - (window.innerWidth - margin);
  const overflowLeft = margin - (box.left + box.width / 2 - width / 2);
  let shift = 0;
  if (overflowRight > 0) shift = -Math.min(overflowRight, width / 2 - 12);
  if (overflowLeft > 0) shift = Math.min(overflowLeft, width / 2 - 12);
  tip.style.setProperty("--tip-shift", `${shift.toFixed(1)}px`);
  tip.classList.toggle("edge-right", shift < 0);
  tip.classList.toggle("edge-left", shift > 0);
}

function closeInfoTips(except) {
  for (const tip of document.querySelectorAll(".info-tip.is-open")) {
    if (tip === except) continue;
    tip.classList.remove("is-open");
    tip.setAttribute("aria-expanded", "false");
    const bubble = tip.querySelector(".info-tip__bubble");
    if (bubble) bubble.setAttribute("aria-hidden", "true");
  }
}

/* The notes themselves. Kept together, keyed by the control they explain, so the copy can be
   reviewed in one place and a field can never carry a tip describing something else. The
   questions are the ones the fields do not answer on their own — not a restatement of the label. */
const FIELD_HELP = {
  captureSmartEnabled:
    "Everything reads what you type and fills in the type, date, person, project and priority for you. A clear sentence saves itself with no button. Turn this off to type the fields yourself.",
  capturePriority:
    "Higher priority sorts nearer the top of Today and Tasks. It does not change the due date or send a reminder on its own.",
  captureDueDate:
    "A date and time puts this on your Schedule, and starts a reminder if you have notifications on.",
  captureRecurrence:
    "Finishing a repeating task creates the next one automatically, a week (or a month) after the date you completed it.",
  capturePerson:
    "Linking a person keeps their notes and contact details together, and lets Ask answer questions about who is involved.",
  captureProject:
    "Group related items so they show up together in Projects and in your Reports.",
  panelStatusSelect:
    "Planned is not on today yet. Today means you intend to do it now. In progress means started. Waiting is blocked on someone else. Someday is deliberately not now.",
  editPriority: "Higher priority sorts nearer the top of Today and Tasks.",
  editRecurrence: "Finishing a repeating task creates the next one automatically.",
};

/* Puts the "i" beside a label. Runs once, at boot, and skips anything already mounted so it is
   safe to call again after a partial re-render. */
function mountFieldHelp() {
  for (const [id, text] of Object.entries(FIELD_HELP)) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (!label || label.dataset.helpMounted) continue;
    label.dataset.helpMounted = "1";
    // Inside the label so it reads as part of the caption, and after the text so the eye reaches
    // the words first and the dot second.
    label.insertAdjacentHTML("beforeend", infoTipMarkup(text));
  }
}

function initInfoTips() {
  if (initInfoTips.done) return;
  initInfoTips.done = true;
  mountFieldHelp();

  document.addEventListener("click", (e) => {
    const tip = e.target.closest(".info-tip");
    if (!tip) {
      closeInfoTips();
      return;
    }
    // Only one bubble at a time: a second opening over the first is just noise.
    closeInfoTips(tip);
    const open = !tip.classList.contains("is-open");
    tip.classList.toggle("is-open", open);
    tip.setAttribute("aria-expanded", String(open));
    const bubble = tip.querySelector(".info-tip__bubble");
    if (bubble) bubble.setAttribute("aria-hidden", String(!open));
    // Closing it has to beat the stylesheet's :hover rule, or on a desktop the bubble stays up
    // because the pointer never left. Lifted again on the way out, so the next hover still works.
    tip.classList.toggle("is-dismissed", !open);
    if (open) positionTip(tip);
  });

  document.addEventListener("mouseover", (e) => {
    const tip = e.target.closest && e.target.closest(".info-tip");
    if (tip) tip.classList.remove("is-dismissed");
  });

  // Escape closes the open one. The app already binds Escape for layers; this sits alongside that
  // rather than inside closeTopmostOverlay, because a tooltip is not a layer and must never be
  // counted as one by the back guard.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInfoTips();
  });

  // A tip whose dot has scrolled away must not stay open over whatever moved into its place.
  window.addEventListener("scroll", () => closeInfoTips(), true);
  window.addEventListener("resize", () => closeInfoTips());
}

/* Swatches show the concept's own palette, so the choice is visible before it is applied. The
   colours come off the theme entry, which is why adding a concept cannot leave this behind. */
function themeSwatch(theme) {
  const [bg, accent, sidebar, card] = theme.swatch || ["#f5f6fb", "#4361ee", "#10152b", "#ffffff"];
  return `<span class="theme-swatch" aria-hidden="true" style="background:${bg}">
            <i style="background:${sidebar}"></i><i style="background:${accent}"></i><i style="background:${card}"></i>
          </span>`;
}

function renderThemePicker() {
  const host = document.getElementById("themeConceptPicker");
  if (!host) return;
  const current = currentThemeConcept();
  host.innerHTML = APP_THEMES.map(
    (theme) => `<button type="button" class="theme-option${theme.id === current ? " active" : ""}"
        data-concept="${escapeHtml(theme.id)}" onclick="setThemeConcept(${jsStr(theme.id)})"
        aria-pressed="${theme.id === current}">
        ${themeSwatch(theme)}
        <span class="theme-option-label">${escapeHtml(theme.label)}</span>
        <span class="theme-option-hint">${escapeHtml(theme.hint)}</span>
      </button>`,
  ).join("");
}

function toggleTheme() {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  state.theme = next;
  save();
  // The concept has its own dark palette, so it has to be told the scheme moved.
  syncThemeScheme();
  const sel = document.getElementById("themeSelect");
  if (sel) sel.value = next;
}
