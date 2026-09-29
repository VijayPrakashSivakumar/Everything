# Everything — Prototype

A working prototype of the "Everything" productivity app: capture, tasks,
inbox, calendar, projects, goals, and AI-assisted search.

## Files
- `index.html` — page structure
- `style.css` — all styling
- `script.js` — app logic (local state + optional multi-user sync)
- `sw.js` — service worker (offline shell + push notifications)
- `api/ask.js` — AI search endpoint (`/api/ask`)
- `api/send-due-notifications.js` — cron/API that pushes due reminders to closed apps
- `scripts/check-vapid.mjs` — verifies a VAPID key pair matches `script.js` (`cd Everything/api && npm run check:vapid`)
- `vercel.json` — declares that cron (also kept in `api/vercel.json`; see *Cron cadence*)

## Features
- **Capture** — text, voice (recording or browser dictation), image, file and link captures,
  with editable smart suggestions for type, date, person, priority, recurrence and project,
  plus duplicate-capture protection. One sentence can unpack into **several** items, and a clear
  one creates itself with no Save click — see *Auto-create* and *One sentence, several things*.
- **Views** — Today, Inbox, Tasks, Schedule (week/month), Memory, People, Projects,
  Goals, Reports and Insights.
- **Ask / Search** — `Ctrl/⌘ + K` or `/` opens search, which answers questions via
  `/api/ask` (any supported model provider) and falls back to keyword matching offline.
- **Quick reschedule** — open any item and use *Reschedule* (Tomorrow 9 AM, +1 day,
  +1 week, clear) instead of editing the date by hand.
- **Repair the name-based links** — items link to a person, project or goal by *name*, so a typo used
  to strand them with no way back. People, projects and goals can be **renamed** (every linked item
  follows), a person can be **removed** (their tag is cleared and the items are kept), and a goal
  refuses a title that is already in use. Every control built from stored text is escaped so an
  apostrophe in a name cannot kill the button.
- **Deeper goals** — a goal carries an optional **target date** (set on the new-goal card or from a
  *Date* button; shown as *Due in 10 days* or *Overdue by 3 days*), items link to a goal by **title**,
  and the goal reports the **progress** of the work attached to it — a done/total bar and the linked
  items themselves. Archived items are left out of the count, and renaming a goal carries its items
  along, because the title is the identity.
- **Fuller people** — each person holds notes, phone, email and birthday, and two records for one
  human (*Ravi* and *Ravi Kumar*) can be **merged**: every linked item moves onto the survivor,
  notes from both sides are kept and the duplicate record is deleted.
- **Task workflow** — tasks support Planned, Today, In progress, Waiting, Someday, and Completed states, with a Priority view, persisted checklist steps, quick conversion, duplication, rescheduling, priority-aware ordering, and reversible Archive/Restore.
- **Reports** — 14-day chart of captures vs completions (completions are logged locally).
- **Insights** — patterns noticed locally: open loops, most active project, most mentioned person,
  busiest weekday, and overdue count, over total/completed/active-day tiles. Computed from your own
  data, so it works offline and costs nothing. Each view renders itself when opened, so Insights is
  correct whether or not Today was visited first.
- **Backup** — Settings → Account → *Export backup* / *Import backup* (JSON round-trip).
- **Keyboard shortcuts** — `Ctrl/⌘ + K` search, `C` quick capture, `/` focus search,
  `Esc` close the top-most dialog.
- **Installable PWA** — offline shell via `sw.js`, plus web-push reminders.
- **Reminders that arrive offline** — see *Reminder delivery* below.
- **Back navigation** — swipe-back walks the pages and unwinds nested layers; see
  *Mobile back navigation*.
- **Themes** — four looks over one set of design tokens; see *Themes*.
- **Inline help** — an "i" beside the fields that are not self-explanatory; see *Inline help*.

## Mobile back navigation

Swipe-back (Android's gesture, and the browser back button on a phone) used to **leave the app**,
because the app never changed the URL, so there was nothing to go back to.

It is now a real history stack, the way a router works:

```
entry  { everything: 1, ev: "today" }                 the view
entry  { everything: 1, ev: "tasks", layer: "modal" } a sheet opened on top
```

- **Views are in the history.** A tap in the navigation pushes an entry, so back walks the pages
  in reverse: Dashboard → Tasks → Projects → back → Tasks.
- **Every layer gets its own entry**, so nested layers unwind one at a time rather than all at
  once. Sheets, the Ask overlay, the item slide-over, the menu and the search dropdown are covered.
- **A layer closed by its own button** (or Escape, or save-and-close) unwinds its entry too, so
  the next back is a real page move instead of a swallowed no-op.
- **At the end of the stack, back does what the platform does.** A web page cannot close its own
  tab; holding a permanent guard would trap people on the site with no way out.

`switchView(id, { history })` takes `"push"` (navigation), `"replace"` (boot, login, a jump from
a panel) or `"none"` (back already owns the position). The default is `"replace"`, so no existing
caller can flood the stack.

Two things that are easy to get wrong, and were caught by the browser probe:

- The pushed entry must record the view being **entered**. Reading the current one stores the
  view being left, and back then always lands one step too far.
- The layer list moved from a CSS selector to `topmostOpenLayer()`, because a selector cannot
  express stacking order. Observation drives the stack, so every existing open/close path is
  covered without touching any of them.

Desktop is unaffected: history just works, and nothing about the layout changes.

## Themes

`data-theme` keeps its original **light/dark** meaning and every rule that reads it is unchanged.
The visual concept is a second, independent attribute: `data-concept`.

| Concept | Feel |
| --- | --- |
| **Default** | the original app, untouched — it has no CSS at all |
| **Premium** | warm neutrals, bronze accent, softer corners, lifted shadow |
| **Deep Work** | near-monochrome, flat, square, high contrast |
| **Casual** | warm and round, terracotta and teal |
| **Aurora** | violet-to-cyan wash behind glass, the largest corners in the app |
| **Editorial** | serif on warm paper, hairline rules, nothing lifted off the page |
| **Dense** | monospaced headings, tight rows, built for the screen you work in |
| **Sage** | botanical green over warm paper — the only natural hue, slow and considered |
| **Bordeaux** | deep wine, the tightest corners outside Dense, warm amber second accent |
| **Rose** | dusty rose and lavender, the most air and the loosest leading outside Editorial |

`data-scheme` is the resolved light/dark value, always written explicitly. Having it as an
attribute is what lets a concept choose its own palette for each scheme with a plain selector,
instead of fighting the OS media query with specificity.

Colours, corners and shadows are all design tokens, so **a new theme is one block of CSS plus one
line in `APP_THEMES`** — no component is duplicated or restyled. Adding another theme is a
five-minute change, and `theme-probe.mjs` picks it up on its own: it reads the concept list from the
app, so a new theme is contrast-checked, screenshot and lightness-checked without editing the probe.
It also requires every concept to carry **its own accent**, so two themes cannot quietly collapse
into the same look.

The concept is applied by a small inline script in `<head>`, before first paint, so the app does
not flash the default and snap a frame later.

**One thing worth knowing:** the sidebar and brand colours were hard-coded light-on-navy. Deep
Work's pale sidebar made them invisible — white text on white, with the whole navigation lost.
They are tokens now, and `theme-probe.mjs` measures the real computed contrast of the nav in every
concept and both schemes, so that cannot come back.

## Reminder delivery
A reminder reaches the user in every state, and never twice:

| Situation | How it is delivered |
| --- | --- |
| App open | Exact per-item timer in `script.js`, shown through the service worker |
| App closed, online | `/api/send-due-notifications` (cron) sends a Web Push to every device in `push_subscriptions` |
| App closed, offline | `sw.js` keeps its own schedule in Cache Storage (survives the app being closed) and fires it itself |
| Missed while offline | The next client that comes back delivers it marked *Missed* (up to 12h later) |
| Notification tapped | *Open* / *Done* / *Snooze 10m* actions; they are handed to the app, or replayed through `?notifAction=…&itemId=…` when it was closed |

`items.reminder_at` / `notified` / `notified_at` / `snoozed_until` are the shared record, so
the push path and the local path stay in step across devices. Settings → Notifications shows
whether this device is registered, whether it is online, and the last deliveries.

### Configuration
| Variable | Needed? | Default / effect |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Required | used by every API route |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Required for closed-app push | must match the public key in `script.js` |
| `VAPID_SUBJECT` | Optional | `mailto:notifications@everything.local` — set a real address for best acceptance, especially on iOS |
| `CRON_SECRET` | Optional | if set, Vercel sends it automatically as `Authorization: Bearer …` and the cron path requires it; the in-app test authenticates with the user's Supabase token instead |
| `REMINDER_TIMEZONE` | Optional | `UTC` — only changes the "Due …" wording inside the notification |
| `REMINDER_LOOKBACK_MINUTES` | Optional | `60` — how far back a missed run still delivers |

### Setting it up on Vercel
1. Project → Settings → Environment Variables (add to Production, and Preview if you test there):
   - `SUPABASE_URL` — Supabase → Project Settings → API → Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — same page, the `service_role` secret (server-side only, never
     in the frontend).
   - `VAPID_PUBLIC_KEY` — must be identical to `VAPID_PUBLIC_KEY` in `script.js`.
   - `VAPID_PRIVATE_KEY` — the private half of that same pair.
   - optional: `VAPID_SUBJECT=mailto:you@gmail.com`, `CRON_SECRET=<random 16+ chars>`,
     `REMINDER_TIMEZONE=Asia/Kolkata`.
2. Lost the private key? Generate a new pair and update `script.js` with the new public key:

```bash
cd Everything/api
node node_modules/web-push/src/cli.js generate-vapid-keys --json   # npx is blocked by the PowerShell execution policy
node ../scripts/check-vapid.mjs --public <new public key> --private <new private key>
```

   `check:vapid` fails when the two keys do not belong together, or do not match `script.js` —
   that mismatch is the usual cause of a rejected push.
3. Redeploy. Environment changes only apply to new deployments.
4. Confirm with `https://<your-project>.vercel.app/api/health`: it reports `pushReady`,
   `reminderSchemaReady` and a `notifications` message.

### Checking delivery end to end
1. Open the deployed site over HTTPS (localhost works too; `file://` does not).
2. Settings → Notifications → *Enable notifications* → Allow.
3. The status block must read *Device notifications: On*, *Closed-app push: Registered …*,
   *Network: Online*. *Not registered yet* means migration `004` has not run, or the worker is
   not active yet (reload once).
4. Press *Send test*: one local notification arrives immediately, a second one confirms the
   server push. When it fails, the second notification names the reason:
   - `VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured` → env vars missing or no redeploy
   - `no push subscription registered yet` → `push_subscriptions` is empty (migration or RLS)
   - `unauthorized` → signed out, or `CRON_SECRET` mismatch
5. Cross-check in Supabase: `select * from push_subscriptions;` and
   `select status, channel, item_id, created_at from notification_log order by created_at desc limit 10;`
6. Real test: add a task due in two minutes, close the app completely, and wait for the push.
7. Phones: install first (Android Chrome → *Install app*; iOS 16.4+ → Safari → Share →
   *Add to Home Screen*), then enable notifications inside the installed app.

### Cron cadence
Vercel **Hobby only allows daily** cron expressions; `* * * * *` fails the deployment with
*"Hobby accounts are limited to daily cron jobs"*. Pro allows once per minute.

- Cron is declared in `vercel.json`. It is kept in **two** places because Vercel only reads the
  file at the project root: `Everything/vercel.json` (root = the app folder, which is what the
  relative `/api/...` calls need) and `Everything/api/vercel.json` (root = the api folder).
  Both currently run once a day at 01:00 (`0 1 * * *`) so a Hobby deploy never fails.
- **Minute-level delivery on Hobby:** run `supabase/reminder-cron.sql` once (after replacing
  `YOUR-PROJECT` and `YOUR_CRON_SECRET`). It uses `pg_cron` + `pg_net` to call the endpoint
  every minute, which works on the Supabase free plan.
- **On Pro:** change the expression in both `vercel.json` files back to `* * * * *` and you can
  skip the Supabase schedule.

Without any server-side trigger the app still delivers reminders whenever it is open or in
the background, and catches up on anything missed the next time it runs.

## Running it locally
This is a static site — no build step needed.

**Open it over HTTP, not `file://`.** Browsers block `fetch("/api/...")` on the `file:`
protocol, so a double-clicked `index.html` silently loses login, sync, AI Ask, and notifications
while the rest of the UI keeps working — which makes the breakage easy to misread as a server
problem. Ask now says "Opened from a file" when this is the cause.

```bash
# Recommended: serve the folder and open http://localhost:8000
python3 -m http.server 8000
```

## Search
Tapping the header search field searches **in place**: matches stream into a dropdown beneath
the field, and the AI answer appears below them once the typing settles. Press `Enter` to open
the full-screen Ask overlay pre-filled with what you typed, or `Escape` to dismiss. `Ctrl+K`
(⌘K on Mac) and `/` still open the overlay directly.

The dropdown and the overlay share one `searchMatches()` helper, so the two can never disagree
about what matches. Memory view search uses it too, instead of a private copy of the matcher.

## Smart capture: analyse, then ask

Capture used to be regex-only. `extractWithAI()` first tried `window.claude`, which exists only
inside a Claude artifact and **never on the deployed site**, so in practice every capture fell
through to pattern matching and the model was never consulted.

Capture now reads in two beats:

1. **Local rules first** — instant, free, offline, and right for a plain "call Ravi tomorrow".
   They also report a **confidence**: an explicit date plus a detected kind is `high`.
2. **The model second, only when needed** — a vague time, a promise, a multi-clause sentence, or
   anything the rules only half-read. The request goes to `/api/ask` with `action: "extract"`,
   reusing the same configured provider (and the same route, because the project is at Vercel
   Hobby's 12-function limit).

The merge is deliberately asymmetric: **a confident local read is never overwritten by the
model**, and a model that fills nothing never erases what the rules found. A failed or
unconfigured model costs the refinement and nothing else — capture always saves.

### Asking instead of inventing

The product rule is that the assistant must not invent what an uncertain phrase means. "Maybe
Friday" is not a date, so the sheet asks rather than guessing:

| You type | Everything does |
| --- | --- |
| `call Ravi tomorrow at 10am about the quote` | task, due tomorrow 10:00 — **no AI call**, instant |
| `maybe friday about the quotation` | asks: *"I read 'maybe' as <date>. Keep that, or pick another day?"* |
| `I'll send the drawings tomorrow` | asks: *"This sounds like something you promised. Shall I keep it as a task?"* |
| `Ravi prefers WhatsApp instead of email` | **memory**, not a task (the verbs say "email") |
| `ring the shop about the quote tomorrow, and remind me to pay the invoice` | two items, not one — see below |

Questions are shown **one at a time**, always dismissible, and never block Save — "suggestions,
not pressure". An answer the person gives is no longer a suggestion, so *Clear suggestions* will
not undo it.

Type, voice and image all end up in the same pipeline, so all three get the same reading.

### The conversation — answering in words

Asking *whether* to keep a sentence is one thing. Asking *when* is another, and the question card
could only ever offer fixed buttons, so a reminder had nowhere to go but a native date picker — the
very form this is meant to remove.

> **🎙️** "Remind me to call Arun."
> **Everything:** Sure. What date?
> **You:** Tomorrow.
> **Everything:** What time?
> **You:** 10 AM.
> **Everything:** *saves it, with an Undo bar*

A **slot** is a value the app refuses to invent — the same rule *"Maybe Friday" is not a date*
already encodes, applied to the whole capture rather than to one phrase. The person supplies it in
their own words, typed or spoken, and it is resolved against the parsers that already exist in
`script.js` (`parseLocalDate`, and a small `parseLocalTimeOnly` for a bare clock time).

| | |
| --- | --- |
| `remind me to …` with no day | opens a conversation — a reminder with no day is not a reminder yet |
| `remind me to … tomorrow` | asks for the time as well, because the hour is still open |
| `tomorrow at 4 pm` as an answer | settles both at once, and does **not** ask twice |
| `banana` as an answer | refused, with an explanation — the same question stays |
| anything that is not a reminder | **never** asked anything, so silent auto-create is untouched |
| Dismiss | ends the conversation; nothing here can block a save |
| editing the sentence | resets the conversation, so an answer never lands on a different sentence |

The trigger is deliberately narrow. A task with no date is a perfectly good task, and a capture
that used to save itself must not start stopping to ask — the engine is for the one case that is
genuinely incomplete, not a general-purpose form.

**The answer is never dictated over the sentence it is about.** The capture recogniser writes into
the main textarea; mid-conversation that would destroy the very sentence under discussion, so it is
routed to a separate recogniser for the answer field, and stopped when the sheet closes.

`conversation-engine-probe.mjs` drives the whole exchange in a real browser and pins both the
feature and the two regressions it could most easily cause.

### A picture with a date on it is asked, not guessed

> 📷 **APOLLO CLINIC — 05 October 2026, 4:00 PM**
> **Everything:** I found a date on 5 Oct 2026, 4:00 PM: Apollo Clinic. What would you like me to do?
> **[ Create event ]  [ Set reminder ]  [ Save as note ]**

A date says **when**, not **what**. A photographed appointment card, ticket or invitation used to
be read and then left to the silent auto-create, which filed it as whatever the rules happened to
call it. A reminder with no day is not a reminder yet; a photograph with a date is not yet an
event. This is the one decision a picture cannot settle by reading it, so it is asked.

| | |
| --- | --- |
| picture with a readable date | offers the three choices, and **creates nothing yet** |
| picture with no date | never asked anything — there is nothing to be uncertain about |
| Create event / Set reminder / Save as note | `event` / `task` / `memory` |
| you already picked a kind yourself | the card never overrides it |
| Dismiss | nothing is created on its own; Save still works |
| you edit the read text | the choice is dropped, because the date it was about is no longer on screen |

`image-choice-probe.mjs` covers it in 10 checks, without loading Tesseract — the probe feeds it the
text a real read would have left behind, so it tests the decision rather than the OCR.

### What a capture is called

A capture that saves itself used to make the **whole sentence** the title of every meeting and
task, which is unreadable in a list. The reading already returns a clean one, so:

| Kind | Title |
| --- | --- |
| task, event, waiting, open loop | the reading's title — *"Design team meeting"* |
| memory (a note), link, voice, image, file | **your own words**, unchanged |
| no reading available | your own words |

`raw_text` always keeps the sentence the item came from, so nothing is lost and the original is
still searchable.

The **duplicate guard is checked against the title that is actually stored**, not the raw text.
That was the subtle part: once titles are normalised, the same sentence twice produces the same
title twice, so the guard finally catches it — checking the raw text would have let a repeated
capture through under a fingerprint that no longer matched.

### Auto-create — "Done."

A clear sentence now saves **itself**. There is no Save click at all, and no form to fill: you
type the sentence, it becomes the items, the sheet closes.

It only earns that when the reading is completely clean — `capturePlanIsClear()` requires every
entry to be **titled**, **typed**, and free of a **question**. One unclear entry and the sheet
asks instead, so *"Meet John sometime next week"* still stops and asks rather than guessing.

| | |
| --- | --- |
| clear sentence | creates every item, closes the sheet, shows *"Saved 2 items · Undo"* |
| any doubt | shows the plan and the question, saves nothing |
| you touch a row | auto-create is cancelled — taking control is a decision |
| you press Save | cancels the pending auto-create; no undo bar, because you chose it |
| smart suggestions off | no reading, so no auto-create |
| voice / image / file / link | never auto-saves — those need their own inputs and an upload |

A silent action is only acceptable if it is cheap to reverse, so the bar names what was made and
**undo removes the whole capture** — one capture that made three items is one action, not three.
It dismisses itself after 8 seconds.

Two details that are easy to get wrong, and were:

- **The auto-save guard is the *channel*, not the kind.** Reading a sentence moves `captureType`
  to `event`/`task`/…, so a `captureType === "text"` test blocks *every* real auto-create. It
  checks for `voice`/`image`/`file`/`link` instead.
- **A comma is a boundary.** `splitCaptureClauses()` originally split on `.` `;` `!` but not
  `,`, so *"meeting at 9, discuss the app, send the proposal"* counted as **one** clause. The
  local rules were then "confident", `captureNeedsModelHelp()` said no, the model was never
  asked, and two thirds of the sentence was silently dropped. Over-splitting only costs one
  request; under-splitting loses work, so the comma belongs in the separator.

A question about **entry 0** also used to be invisible — it drives the form, which has nowhere
to show one. It now appears in the plan block as `.capture-plan-ask`.

### One sentence, several things

One capture used to save exactly **one** item. `splitCaptureClauses()` only decided *whether to
call the model*, so "ring the shop about the quote tomorrow, and remind me to pay the invoice"
had its second clause folded into the first item's title — one long title, one reminder, and the
invoice effectively lost.

The model now returns **one entry per distinct thing** (`{"items":[…]}` from
`buildExtractionPrompt`, read by `parseExtractionPlan` in `api/ask.js`). Take:

> Tomorrow we have a meeting with the design team at 9 AM. Need to discuss the new app and send
> the proposal afterward.

| Entry | Becomes |
| --- | --- |
| event — *Design team meeting*, tomorrow 09:00 | the item the form is editing |
| agenda — *Discuss the new app* | a **checklist step on the meeting**, not a second item |
| task — *Send the proposal* | its **own item**, `capture_metadata.planOf` pointing at the meeting |

How it is put in front of the person, and why:

- **Entry 0 drives the form** the sheet already shows, so the single-item path is untouched and
  the main item keeps your typed text as its title, exactly as before.
- **The rest appear as a short list** under the suggestions — title, type and date, each editable,
  each removable. The list is shown *before* saving, so less typing never means an action the
  person was not told about.
- **The Save button counts**: *Save 4 items*. The fan-out is stated, not assumed.
- **Retyping invalidates the plan**, so a stale suggestion can never be saved beside words you
  have since changed. *Clear suggestions* clears it too.
- **Capped at 6 extra items** (`CAPTURE_PLAN_LIMIT`, `MAX_PLAN_ITEMS`) so a run-on sentence or a
  wall of pasted text cannot flood the inbox.
- `extraction` is still returned as the first entry, so a browser on the previous build keeps
  working and still captures one item.

`agenda` is deliberately **not** a stored kind — it exists only so the model can say "this belongs
to the meeting". `normalisePlanEntry()` must therefore let `agenda` survive normalisation, or
every agenda line would silently become a task.

`Everything/tests/plan-probe.mjs` drives this in a real browser with a mocked `/api/ask`: one
sentence in, two items and a checklist step out. `npm test` runs it.

## Voice and image capture

**Dictation language** — the picker in the Voice capture decides which language the browser
recogniser listens for (English, தமிழ், हिन्दి, తెలుగు, ಕನ್ನಡ, മലയಾളം). It used to follow
`navigator.language`, so a Tamil speaker with an English browser got an English transcription of
Tamil speech. The language used is saved on the capture so the transcript reads back correctly.

**Reading text from a picture** — *Capture → Image → Read text from image* runs OCR with
Tesseract.js **inside the browser**:

- **Free, private and offline-capable.** No API key, no cost, and the image never leaves the
  device. Nothing is sent to a model provider.
- **Opt-in.** The engine is fetched from a CDN only when the button is pressed, so ordinary
  capture never downloads it.
- **Safe when it fails.** Offline or a blocked CDN produces one line explaining that, and the
  capture sheet keeps working — you can always type the note yourself.
- **One code path.** Recognised text is placed into the normal capture field, so a photographed
  receipt or note gets the *same* smart suggestions, duplicate protection and Task/Event/Reminder
  outcome as typed text.
- The recognised text and the language are stored with the capture, so the original reading stays
  auditable.

> **Vision is deliberately not here.** A model that *understands* an image (not just reads it)
> needs a vision model. On a 2-core / 8 GB laptop without a GPU that is not practical — a text
> model already took ~36 s to answer "ok". The provider adapter in `api/ask.js` is where a
> self-hosted vision model will be added once suitable hardware is available; no rework is needed
> in the capture flow.

## How Ask finds what to answer

Ask is only as good as the context it is given, so retrieval matters more than the model:

- **Stop words are dropped.** "what should I do today" is searched as the terms that carry
  meaning, not as one long phrase that appears in no title — otherwise every real question
  silently matched nothing.
- **Every field is searchable** — title, notes, person, project, workflow status, priority,
  kind, recurrence and checklist steps.
- **Natural words map to stored values.** Typing *urgent* finds items whose priority is stored
  as `high`; *blocked* finds `waiting`.
- **Results are ranked, best first** (title hits and whole-phrase hits score highest), so the
  AI sees the items that answer the question rather than the first N in insertion order.
- **Broad questions still get context.** A question with few keyword matches is topped up with
  recent open items, because one item is not enough to answer with. The pool is bounded for
  the provider's input-token cap.
- **The prompt carries the date and the state.** The browser sends its local date (the server
  clock may be UTC) and every item line states its status, project, due date and checklist
  progress, so "what is due today" and "what am I waiting on" are answerable at all.

A stale answer can never overwrite a newer one. Each call takes a ticket and only the newest wins
— but a *re-render* is not a newer question, so it must not discard an answer that is already on
screen. `askAI()` therefore re-resolves its slot by id on every write instead of holding the
original node, which the dropdown detaches on each keystroke. Getting this wrong left the header
search sitting on "Thinking…" forever.

A silent fallback is never reported as a healthy app. `complete()` takes an opt-in `trace`
flag; when set, a successful result also carries `attempted` (what was tried and why it failed)
and `degraded`. `/api/health?probe=1` uses it, so a dead primary can no longer hide behind a
working fallback — the probe reports `ok: true` *and* `degraded: true` with the real reason,
plus `configuredProvider` (who was meant to answer) next to `provider` (who did).

A provider that just failed is skipped for five minutes so it cannot burn the per-attempt budget on
every query. This is per warm instance and best effort: correctness never depends on it, a cold
start simply tries the normal order, and the skip expires on its own so a key fixed in Vercel
starts being used again within minutes with no redeploy.

## Back gesture on mobile
A history entry is pushed while a dismissible layer is open (Capture sheet, Ask overlay, item
panel, sidebar, or the search dropdown) and popped when it closes, so Android's back swipe
always closes the top layer rather than walking out to the previous page. With nothing open,
back is left to the browser, which backgrounds the app. A page cannot close its own tab, and
holding a permanent guard would trap the user on the site, so that is deliberately not done.


## Local model (Ollama) — free and private
Settings → AI turns on a model running on your own computer. It answers Ask questions and reads
captured sentences, and the cloud provider is only used if the local one is off or unreachable.

It is a **browser-side** call, deliberately. `/api/ask` runs on Vercel and cannot reach
`localhost:11434`, so an `ollama` entry in that provider chain would look correct and never answer.
The browser talking to Ollama directly is also why nothing you type leaves the machine.

Because a local model costs nothing, it is tried *before* the cloud and is **not** subject to the
6-second `MODEL_MIN_INTERVAL_MS` throttle — that throttle exists to protect a free cloud tier's
quota, which does not apply here. Reachability is probed once per session, so a machine with no
Ollama does not pay a failed request on every question.

### Setting it up

```bash
# 1. install Ollama, then pull a model
ollama pull llama3.2

# 2. allow this site's origin (required — the browser blocks it otherwise)
#    Windows: set OLLAMA_ORIGINS as a user environment variable, then restart Ollama
#    macOS:   launchctl setenv OLLAMA_ORIGINS "http://localhost:8000"
setx OLLAMA_ORIGINS "https://your-app.vercel.app,http://localhost:8000"
```

Then Settings → AI → pick the model.

### Limits worth knowing
- **Same machine only.** A phone opening the app reaches its own `localhost`, not your PC. A LAN
  address would work with `OLLAMA_HOST=0.0.0.0`, but an HTTPS page is not allowed to call a plain
  HTTP address that is not `localhost`.
- **Chrome, Edge and Firefox** allow `http://localhost` from an HTTPS page, because `localhost`
  counts as a secure origin. **Safari is stricter** and may block it.
- Smart capture sends `format: "json"`, so a small model returns parseable JSON. The reply is
  normalised in the browser exactly as the server normalises it, so a capture reads the same
  whichever model answered.

### Using it from a phone — the free tunnel

**This is the only thing that stops a local model being useful.** An HTTPS page is not allowed to
call a plain-HTTP address on your LAN, and a phone resolves `localhost` to *itself*, not your PC. So
without help, Ollama only ever works on the computer that runs it.

A **Cloudflare quick tunnel** solves it for nothing: no account, no card, no domain. It gives your
computer a public HTTPS address, which satisfies the browser's rule *and* makes the model reachable
from anywhere.

```bash
cloudflared tunnel --url http://localhost:11434
```

It prints an address like `https://odd-words-here.trycloudflare.com`. Paste that into
**Settings → AI → Ollama address** and save. On the phone, the model is now free, unlimited, and
private.

Two things that are guaranteed to happen, and are handled:

- **You will paste the whole cloudflared banner**, because that is what you have on screen.
  `normaliseLocalModelUrl()` unwraps the address out of it, so a pasted line works as well as a
  pasted URL. Nonsense falls back to `localhost` rather than being stored and failing forever.
- **The address changes every time cloudflared restarts.** A saved one goes stale with nothing
  actually broken, which used to produce a baffling *"Not reachable"*. The app now recognises a
  `trycloudflare.com` address and says so: *"Cloudflare gives a new one every time cloudflared
  restarts — copy the address it is printing now."* A genuine outage on some other address is **not**
  blamed on the tunnel, because that would send you chasing the wrong thing.

The Settings card carries the command inline, under **"Use this from a phone (free)"**.

**What a quick tunnel does not give you:** a *stable* address. If you want the address to stop
changing, that needs a named tunnel and a domain you own (~$10/year). The quick tunnel is the free
option and the right one to start with.

**CORS still applies.** Ollama must be told to allow the site's origin. With a random tunnel address
you cannot pre-list it, so on a machine you trust, `setx OLLAMA_ORIGINS "*"` is the practical answer
— and it is only exposed while `cloudflared` is running, which you control.

## Conflict-safe sync

**This was the one thing that could lose data, and it did.** The old sync was:

```js
state.items = data.map(rowToItem);   // on every load
state.items[idx] = updated;          // on every realtime push
```

Wholesale last-write-wins, with no timestamp to compare. Three separate ways to lose something,
all silent:

1. An item captured while the server was unreachable was in `localStorage` one moment and gone the
   next, replaced by whatever the server had.
2. A write that exhausted its retries was `removeStructuredSyncOperation`'d — a `console.warn` and
   nothing else. The item stayed on the device looking perfectly normal and was never on the server,
   where (1) then deleted it.
3. Two people editing one task produced one of them, with no indication which, or that a second
   version had ever existed.

### What replaced it

`mergeItemLists()` merges instead of replacing. The rules, in order:

- an item the **server has never seen is always kept**, and queued to be pushed
- an item **not dirty here** takes the server's copy silently (ordinary sync, stays quiet)
- a **genuinely divergent** item takes the newer edit **and keeps the loser**

`dirty` is set in `dbSaveItem`, which every mutation funnels through, so it means exactly "this
device has an edit the server has not seen." `updatedAt` is stamped in the same place and sent with
the write (`items.updated_at`, migration 009).

### The deliberate limit

**Client clocks are not trustworthy across devices.** `updatedAt` picks a winner, but it is never
allowed to be the only thing standing between a person and their data:

- **No trigger on `items.updated_at`**, unlike every other table. A trigger would stamp the server's
  clock on every write and destroy the one thing conflict resolution needs — when the edit was
  actually *made*. The client supplies its own time; server-side writers set it explicitly.
- **Every conflict keeps both versions** and is shown in **Review → "Edited on two devices"**, with
  *Keep mine* / *Keep theirs*. The losing text is never discarded automatically.
- **A write that fails permanently is parked, not dropped**, and listed with a *Retry now* button.
  An item that never reached the server now says so instead of pretending it synced.

So the honest claim is: **a merge may reorder or choose, but it may not destroy.** You can lose the
*ordering* between two versions; you cannot lose *either* version.

What is deliberately **not** claimed: full CRDT-level convergence. That needs server-assigned
sequence numbers and conditional updates (`where rev = <seen>`), which is a larger change to
`api/`. Until then the conflict banner is the backstop, and it is the thing to watch for.

### Verifying it, rather than assuming

Two things can silently undo all of this, and both are now checked.

**The migration.** `detectUpdatedAtColumn()` probes once and falls back to "server copy wins" — so
an unapplied `009` does not error, it just quietly reverts the fix while every offline test still
passes. `node Everything/tests/ui-structure.test.mjs --live` now fails loudly and names the
migration to run.

**The wiring.** The tests above call `mergeItemLists()` directly. That leaves the *call site*
unguarded, and the two destructive lines in this project's history were both call sites. They
compile, they leave every unit test green, and they delete data. `ui-structure.test.mjs` now
asserts the load path merges, the realtime path merges, failed writes are parked rather than
removed, and `dbSaveItem` stamps `updatedAt`/`dirty` — so a regression fails the build.

Those checks strip comments first, because the fix is documented in a comment that quotes the old
broken line verbatim; a naive search finds the comment describing its own removal and reports the
fix as the regression.

**Row Level Security** is also asserted live, not assumed. The anon key ships in `script.js`, so it
is public; the live probe reads every table as the anonymous role and fails if a single row comes
back. That is the difference between a private app and every capture published to anyone who loads
the page.

### The other three collections — and the half-fix

Fixing items and stopping there would have been the worst outcome. `startSupabaseSync` had the
identical bug **three lines further down**, for the collections that had no merge at all:

```js
if (projectRows) state.projects = projectRows.map(...)   // wholesale replace
if (goalRows)     state.goals    = goalRows.map(...)     // wholesale replace
if (peopleRows)   state.people   = peopleRows.map(...)   // wholesale replace
```

and their realtime path was `list[index] = { ...list[index], ...normalized }` — a last-write-wins
spread. A person added on a phone with no signal vanished on the next load, along with their
phone number and every item linked to them. **This was running in production.**

`mergeRecordLists()` / `mergeRecordPair()` now cover all three, driven by one loop over
`["project", "goal", "person"]`, so a collection added later is picked up rather than silently
skipped. The conflict card already existed and needed no change.

### One asymmetry, stated plainly

`items` uses the **client's** edit time, deliberately — that is migration 009, and the trigger was
left off on purpose.

`projects`, `goals` and `people` use the **server's** clock, because those three have carried an
`updated_at` trigger since migration 002. Dropping it to match items was declined in favour of not
touching working tables.

What that costs, stated honestly: those three conflicts are ordered by *when the server recorded
the write*, not when the edit was made. In practice that is a difference of seconds, and it buys a
single consistent clock instead of comparing two device clocks that cannot be trusted to agree — so
it is a defensible trade, but it is not the same guarantee as items, and it should not be described
as though it were. Nothing is lost either way: the losing version is kept and shown regardless of
which clock decided the order.

## Four gaps closed

Four things the app plainly should have had and did not. Each looked finished once written and was
a step short of working, which is the pattern worth recording.

### Command palette — `Ctrl+Shift+K`

Thirteen pages in the nav, an Ask overlay, and a search dropdown: three ways to find things, none
of which could reach a *record*, and all of which needed the mouse. The palette lists actions,
pages, and — once you type — matching people, projects, goals and items.

Two decisions worth stating:

- **`Ctrl+K` still opens Ask.** It is documented in three places and asserted by an audit. The
  palette took `Ctrl+Shift+K` instead. Repurposing a shipped shortcut leaves people with muscle
  memory that fights them.
- **Items are matched through `searchMatches()`**, not a filter of its own. A second matcher would
  let the palette and the header search disagree about the same typo, which is worse than either
  being wrong alone. There is a test that asserts they return the same rows for the same typo.

### People: searchable, and honest about who is a contact

The People view was the only list with no filter box — Inbox and Memory both had one. It matches
name, **phone and email**, because that is how you actually look someone up when you half-know
them.

The bigger problem was that the list mixed two different things and looked identical. Names
inferred from a task that merely mentions someone sat next to saved contacts, with no label. So an
inferred name looked editable, and typing a phone number into it went nowhere and looked like a
bug. Inferred names are now labelled **"From a task"** and can be **promoted** into a real record,
at which point the label disappears — a label that outlives its condition is a lie.

### Bulk actions on the task list

Select multiple, then complete / archive / delete. Hidden behind an explicit toggle rather than a
long-press, because **long-press on a row is now the drag gesture** — the two would have fought.
In select mode a tap anywhere on the row toggles it, because making someone aim at a small circle
for a fifty-item selection is how bulk features get abandoned. Destructive actions are disabled
with nothing selected; delete confirms and says how many.

### Drag to reorder — and the bug that hid it

Task lists reorder by press-and-hold, using the dashboard's existing approach. The dashboard's
~55-line drag was **replaced** by a shared `enableListReordering()` rather than copied, so there is
one implementation.

Writing the test found that the original approach could not have worked, and had probably never
worked:

- **`pointermove` was bound to the row being dragged.** The instant a drag begins, the pointer
  leaves that row — so it received exactly one move and then went silent. The move and release
  listeners now live on the document.
- **`draggable = true` cancelled the pointer stream entirely.** Setting it starts a native HTML5
  drag, which suppresses `pointermove` for the rest of the gesture. The drag visibly started
  (ghost outline, `reorder-active` on the container) and then did nothing, on every move.

The dashboard survived both because its cards are large enough that the first move usually landed
on a card it also handled. A 45px task row does not forgive it. `draggable` is now never set, and
the native path is explicitly refused so a future change cannot quietly reintroduce it.

Manual order is stored locally and applied as a **sort**, not a DOM shuffle — a shuffle is undone
by the next render, which happens on every sync. It is deliberately *not* synced: a hand-picked
order that synced would fight every other device's sort on every load. It is also only offered on
"All" and "Today"; on Overdue or Completed the list is already ordered by a rule, and a manual
order outranking "3 days late" would make the tab lie about what it is showing.

### The palette was unreachable on a phone

`Ctrl+Shift+K` was the **only** way to open the palette. On a phone there is no keyboard shortcut
and no button, so the feature did not exist on the device it was built for — and fourteen desktop
checks passed the whole time. A phone-only topbar button fixes it; it is hidden on desktop, where
the shortcut and the header search already cover it.

Its CSS is declared *after* `.icon-btn` deliberately. Both are a single class, so the later rule
wins at equal specificity, and `.icon-btn`'s own `display: flex` left the button 36px wide on
every screen until the order was fixed.

Adding it also made the topbar overflow: seven controls at 390px, and the search box squeezed to
106px against a 120px floor. The **theme toggle** is what went, on the reasoning that the app already
follows the system dark-mode setting so the button duplicated a preference the device had.

That reasoning was wrong, and the symptom is the point. `prefers-color-scheme` only picks the
*initial* scheme. The app has a real per-account appearance setting — a light/dark select and a
concept picker in Settings — and once a user has deliberately chosen dark, the header toggle is the
only **one-tap** route back. Hiding it left a phone user with no way out of a choice they did not
make, short of digging through Settings on a phone. On a phone-first app that is a dead end, and it
was introduced while adding a *mobile* feature.

The fix was to find the space rather than to remove the control. Measured at 390px with the toggle
back, the width came from the topbar gap (4px to 2px, 12px), the side padding (10px to 8px, 4px)
and the capture mark (50x20 to 44x18, 6px) — 22px reclaimed without touching the search field,
which then measured 128px against its 120px floor.

The lesson generalises past this button: **hiding a control to make a layout fit is a real cost to
the user, not a free simplification.** Reclaim space from padding, gaps and decoration first, and
if something genuinely must go, it should be a duplicate of something else rather than the only
route to a feature.

Two checks in `mobile-audit.mjs` now hold both halves at once, because the trade is easy to undo by
accident — hiding one button *looks* like it fixes the layout:

- no topbar control may be missing or hidden at 390px, and
- the search field must still clear its 120px floor with every control shown.

Restoring the toggle also narrowed the search input enough to truncate the placeholder to
"Search an", so the placeholder now swaps to a short form under 900px. That is checked too: a
placeholder that does not fit is not a horizontal-overflow failure, so nothing else caught it.
"Search..." measures 64px against 77px available; the first attempt, "Search or ask...", is 112px
and truncated just as badly. Both numbers are measured, not estimated.

### The topbar only fit the one phone it was measured on

The section above fixed the topbar at 390px, and said so. The floor was real, the arithmetic was
right, and both were only true at that one width. The search field is the only child of the topbar
allowed to shrink (`.search-wrap { flex: 1 1 auto; min-width: 0 }`) while every control beside it is
a fixed 40px tap target, so the whole shortfall lands on the field and nothing else moves. On a
360px screen — a 1080px display at DPR 3, which is most Android phones — it measured **98px** with
the placeholder cut to "Searc"; at 320px it was **58px**, one character wide. The audit passed
throughout, because the audit only ever opened a 390px viewport.

**A layout fixed by reclaiming space has to say which width it reclaimed it for.** Each of the 22px
the theme toggle cost came from somewhere different — the gap, the side padding, the capture mark —
and every one of those was sized against 390px and nothing else.

What gives way is the capture mark, below 382px: the width at which the other six children, the 2px
gaps and the side padding come to 262px and leave the field exactly 120px. It is the one topbar
element that is a logo rather than a control, and it duplicates the mark in the sidebar brand, so
the trade is a duplicate against a readable field rather than a feature against a readable field —
which is the distinction the theme toggle taught. Below 336px the last 20px comes out of the gaps
and the field's own inner padding, because the controls cannot give anything without dropping under
the 40px tap minimum the same audit holds them to.

`mobile-audit.mjs` measures 360px and 320px now, which is what should have been there from the
start. The 120px floor is asserted where it can hold; at 320px, where seven controls and a 120px
field cannot coexist, the check is the visible symptom instead — that the placeholder still fits.
Both failures were reproduced at both widths before the CSS was written, so the new checks are known
to bite rather than assumed to.

### Bulk actions reached the Tasks list and not the Inbox

The Inbox holds every capture, is the list people revisit most, and outgrows the Tasks list
quickest. It had nothing.

The selection is scoped to one list, because both draw the same rows: a selection made in Tasks
must not survive into the Inbox, where "complete 3 selected" would silently reach records the
person never looked at, from a bar they never opened.

### Undo, not a dialog

Bulk archive is reversible, so it gets an undo bar. Bulk delete keeps its `confirm()` **and** gains
an undo: the dialog catches the accidental tap, the undo catches the person who agreed with the
dialog and changed their mind thirty seconds later. It shares the capture flow's existing bar
rather than adding a second near-identical one, which is how one of them ends up with a shorter
timeout and no way to tell which is showing.

A restored item comes back at the end of the list and not as a completed shell. It does **not**
resurrect a recurring occurrence: the series key is a generated id, so silently recreating a
scheduled future task would be a surprise rather than an undo.

### Swipe, and the three bugs it took to make it work

A horizontal drag slides a row aside to reveal Done and Archive. The Inbox swipes; the Tasks list
reorders; **no row does both**, because those are two competing horizontal gestures and the person
would get whichever the browser recognised first.

Three real bugs, each found by instrumenting a live drag rather than by reasoning about it:

1. **The gesture binder lived inside `enableListReordering`, which the Inbox never calls.** Rows
   were marked swipeable, had actions attached, and no way to trigger any of it.
2. **The revealed action buttons sat over the row's own box**, so a press near the right edge
   landed on an invisible button, the "pressed a control" guard fired, and the swipe never started.
   Fixed with `pointer-events: none` until the row is open.
3. **`setPointerCapture` retargeted the click onto the row**, so a revealed action's own handler
   never ran — the buttons rendered and did nothing. A press that lands on a *revealed* action now
   skips the gesture entirely.

Plus the one that would have made the whole gesture pointless: **a swipe ends with a click**, and
that click fell through to `openPanel()`, so swiping a row opened the very item being swiped. The
suppression is per-row and read once — a module-level flag on a timer swallowed the *next* real
tap, including a deliberate press on a revealed button.

### The swipe worked, and was still wrong on a phone

Two screenshots, a palette overlapping the page and an Inbox painting its buttons over its own
text. Every test that existed passed, because every one of them asked whether the gesture
*worked*, and it did — on a desktop viewport, with a single row, opened once.

Four separate causes, none of which is visible in the source:

1. **The palette had a class with no rule under it anywhere.** It reuses `.ask-overlay` but carries
   its own `.ask-panel`, which appears in the markup and nowhere in the stylesheet. An unstyled div
   is transparent *and* shrink-to-fit, so the panel opened as a 222px hole in a 390px screen: the
   dashboard, the capture bar and the stat cards all showed through it, and the input was only as
   wide as its own default size, which cut the placeholder to `"Jump to a page, a task, a pe"`.

   The lesson is not "add the CSS". It is that **a class used in markup is a claim about the
   stylesheet, and nothing checked the claim.** Fourteen desktop checks opened this palette, found
   rows in it and matched text in it. A feature can be entirely reachable and entirely unusable at
   the same time, and reachability is what the tests were measuring.

2. **The row's layout lived on the row, and the swipe put a wrapper in between.** On a phone
   `.task-row` becomes a grid keyed on its *direct* children — `.task-row > .checkbox`,
   `.task-row > .task-meta`. Wrapping those children in `.swipe-row-body` to make them slideable
   moved them one level down, and every one of those selectors stopped matching the moment a row
   became swipeable. A swipeable row on a phone had no grid at all: the checkbox, title and badges
   collapsed into a single flex line, and the revealed buttons were painted straight over them.

3. **The strip was only as wide as its own text.** It is what covers the buttons until the swipe,
   and an opaque strip that does not reach the edges is not a cover. So every *closed* row showed
   a slice of its own buttons beside its title — the overlap in the screenshot, on rows nobody had
   touched.

4. **The transform was on the row, which moved the buttons with it.** The actions are positioned
   against the row, so translating the row left them stranded 168px from the edge they are pinned
   to. The reveal is now the strip sliding out from under buttons that stay put, which is what
   "swipe to reveal" has always meant.

The fourth one had a consequence worth writing down, because the fix nearly introduced a worse bug.
Closing the row inside the gesture's own `pointerup` — correct on its own, and needed so that
opening a second row closes the first — also fired on a **tap**, and a tap is not a swipe. The row
was therefore already shut by the time the click arrived, and the click found no `swiped-open` to
match, so tapping a row to close it opened the item instead. The tap-to-close path is a race
between two handlers for one gesture, and the fix was to let `finish()` do nothing at all unless a
swipe was actually decided.

**One row at a time is the whole invariant.** `swipeOpenRow` is a single slot, and opening a
second row used to overwrite the pointer to the first — which stayed slid aside with nothing able
to close it, its buttons sitting on top of the row below. There is no timer and no cleanup list
because there is only ever one value to keep correct.

### The swipe revealed the buttons by hiding the item

Swiping slid the row's **own content** 168px left, out of the row's clipping window — so the checkbox,
title and badges all left the visible area and the opened row showed nothing but buttons. The item
you were about to mark done disappeared at the moment you needed to see it.

The geometry was already right; what was wrong was *what moved*. Two fixes, and they only work
together: the body moves **only during the gesture** and lands back at 0, and the actions sit
**above** the opaque strip (`z-index: 2` against the strip's `1`), clipped by the row's
`overflow: hidden`. With the content pinned nothing else animates, so the buttons carry the motion
themselves — a 180ms fade from a 16px offset.

Two silent CSS traps in the same area:

- **`.task-row.swipeable` kept its 1px border while setting `padding: 0`.** The strip carries an
  identical border, so the two stacked and left a 2px seam down the right edge, doubled on hover.
- **The phone grid never reached the strip.** `.task-row .swipe-row-body` (two classes) beats a bare
  `.swipe-row-body` (one class) *regardless of order*, so the restated mobile rules silently did
  nothing. Restating a rule is not enough — it must match the specificity of the rule it replaces.
  When a responsive override "does not apply", suspect specificity before order.

The lesson generalises: **a reveal must not cost you the thing being revealed.**

What all four have in common: each was invisible to a test that asked the feature-level question.
The checks that catch them are geometry checks — *is the panel opaque*, *is the strip as wide as the
row*, *is the button block as wide as the slide* — and those only exist because the failure was
reproduced in a real browser and measured rather than reasoned about.

# Working in this repo — read this before editing

These are not style preferences. Each one is here because breaking it cost real time, and the
cost is written down so it does not have to be paid again.

## 1. Run `npm run verify` after every edit, not just before a test run

```
node Everything/tests/verify.mjs
```

It takes about a second and it catches the failure mode that actually happens here: an edit that
lands in the **wrong place** rather than being wrong.

- **A positional insert is blind.** Inserting "at line 241" does not know what is on line 241. The
  number came from a read that had gone stale, so the insert landed inside a
  `try { ... } finally { ... }` and produced a duplicate `} finally {` and a check body truncated
  mid-function, with the next `await check(...)` swallowed inside it.
- **Prefer a text-anchored edit.** `old_text` that does not match fails loudly and changes nothing.
  A line number never fails — it just writes in the wrong place.
- **Never trust a line number from a read that warned it was stale.** Re-read first, or edit by
  anchor. The warning in the tool output was there precisely so this would not happen.
- **Batch edits hide damage.** Three inserts in a row, each moving the target for the next, is how
  one broken edit became three. One edit, then verify, then the next.

## 2. A `node --check` pass is not enough on its own

Parsing proves a file is valid JavaScript. It does not prove a check still *runs*. An edit that
replaced a check instead of adding one next to it leaves a file that parses, runs, prints one
fewer line, and reports success. `verify.mjs` checks the shape as well as the parse: a check
nested inside another is the signature of a truncated body.

## 3. A banner must never contradict the lines above it

`run-all.mjs` scores a suite on `/ALL (\d+) [A-Z -]*PASSED/`. A banner counting *passes* prints
"ALL 14 CHECKS PASSED" directly beneath two `FAIL` lines. The exit code is the only thing that
disagrees, and a reader scanning output sees a pass. Always `results.length`, never a filter on
`'PASS'`.

## 4. Diagnostics get deleted before they get committed

A `console.log` left in `script.js` and a throwaway probe file both shipped once. `verify.mjs`
flags both — a `console.log` matching a diagnostic string, and any `_*` file in `tests/`.

## 5. Check the shape of what already exists before asserting on it

The first version of the banner check demanded one exact string and flagged **fifteen healthy
files**, because every suite words its own label ("AUTO-SAVE CHECKS", "NEXT-ACTION CHECKS",
"TESTS"). It was the same mistake the script exists to prevent. Read the existing convention, then
match it.

## 6. Instrument rather than reason when a runtime behaviour misbehaves

Three separate bugs in the swipe gesture were each found by logging the live event stream, and my
first three hypotheses were wrong every time. A wrong theory costs one more cycle; a logged
event sequence costs none. Reach for the instrument early.

## Signing out was leaking the previous account's data

Asked to improve the sign-out module, because it looked basic. It was worse than basic.

`everything_state_v1` was **one localStorage key shared by every account on the device.** Signing
out cleared the Supabase session and emptied the password field, and left that key exactly as it
was. The next person to sign in on a shared phone therefore inherited the previous person's
captures, goals, people and projects — and because the merge treats unknown local records as
local-only edits, it then **pushed them into their own account**.

So the merge work made this worse, not better. Before, the wholesale replace discarded them; now
they were being carefully preserved and uploaded to the wrong person. Two fixes that each looked
correct in isolation, compounding into a privacy bug.

The fix is two halves, and both are needed:

- **State is keyed per account** (`everything_state_v1:<user id>`), so accounts cannot see each
  other even transiently.
- **Signing out clears the slot** anyway, because the per-user key alone still leaves the previous
  person's data in localStorage for anyone who opens devtools on the family tablet.

Clearing is deliberately **after** `signOut()` resolves rather than before. A failed sign-out must
not destroy the data of someone the server still considers signed in — that would lock them out of
work that only ever existed on that device. There is a test for exactly that.

Also fixed while in there:

- `sbUser` was assigned *after* the column probes in `startSupabaseSync`, but the storage key is
  derived from it, so the merge and any save during startup could write to the wrong account.
- The retry timer was left running after sign-out and would re-create the queue key that had just
  been deleted.
- **Three different sign-outs existed**: the nav page, a raw browser `confirm()` dialog, and a
  Settings button that signed out with no warning at all. All three now go to one page.
- `confirmLogoutPage` retyped the button's HTML on failure, so renaming it in `index.html` was
  silently undone. It now captures and restores the label.

The sign-in page gained a "New here? How to get in" panel, because the sign-up flow has a
confirm-your-email step that people miss and then conclude the app is broken.

## Typo-tolerant search
The exact matcher is substring-only, so a plural or a single typo found nothing. A fuzzy fallback now
runs when — and only when — the exact pass returns nothing, so existing results keep their exact
order and fuzzy can never reorder or drop a match. It matches per word: conservative English
stemming first ("grocery" finds "Groceries"), then a bounded Levenshtein distance.

It is deliberately narrow. Words under four characters are never fuzzy matched, because "car" is one
edit from "cat", "bar" and "can". Distance is 1, rising to 2 only at six characters or more. A query
over six words, or a scan past 400 items, is refused rather than guessed at, because on a phone this
runs on every keystroke.


## Tests
The suites run offline — no API key, no login, no network:

```bash
node Everything/tests/ask-adapter.test.mjs   # provider fallback, shared budget, reason trail
node Everything/tests/ui-structure.test.mjs  # search wiring, mobile layout, back guard, schema
node Everything/tests/plan-probe.mjs         # capture fan-out, in a real browser
node Everything/tests/plan-visual.mjs        # plan layout, escaping, phone fit, screenshots
node Everything/tests/autosave-probe.mjs      # auto-create, the doubt path, undo
node Everything/tests/theme-probe.mjs         # theme contrast, in a real browser
node Everything/tests/back-nav-probe.mjs       # history stack, layers, the menu
node Everything/tests/search-probe.mjs        # exact-first ranking, plurals, typos, speed
```

`npm test` runs all nine through `Everything/tests/run-all.mjs`. The two plan checks need Playwright
(already a dev dependency) and start their own static server (ports 4399 and 4402); they mock
`/api/ask`, so they need no API key and make no model call. `plan-visual.mjs` writes
`tmp/plan-desktop.png` and `tmp/plan-mobile.png` so the layout can be looked at rather than inferred.

```bash
npm install && npx playwright install chromium   # once, before the browser suites
npm test                                          # all nine, with a summary
node Everything/tests/run-all.mjs ask mobile      # only the named suites
node Everything/tests/run-all.mjs --bail          # stop at the first failure
```

**Why the runner exists rather than a `&&` chain.** The old script was
`node a.mjs && node b.mjs && …`, and `&&` ends the run at the first non-zero exit — including a
suite that never started. Playwright was declared in `devDependencies` but had not been installed,
so `plan-probe.mjs` died with `ERR_MODULE_NOT_FOUND` and the **six suites after it never ran at
all**. The output simply stopped mid-list, which reads like a finished run: two thirds of the
browser coverage vanished silently, and the exit code was the only clue.

`run-all.mjs` runs every suite regardless, each under its own 120s timeout so a hung browser or a
hung socket cannot block the terminal, and classifies the outcome per suite:

| Result | Meaning |
| --- | --- |
| `PASSED` | the suite ran and its own banner confirms every check |
| `FAILED` | it ran and something failed, or it could not start for a real reason |
| `SKIPPED` | a dependency is missing, named in the line — missing coverage, **not** a pass |
| `TIMEOUT` | it exceeded its budget and was killed |

It prints `N of 9 suites ran` and exits non-zero if any suite was skipped, so a partial run can
never read as a green one. Set `ALLOW_SKIP=1` to accept a partial run deliberately.

`mobile-audit.mjs` is the one exception: it drives the installed Google Chrome over the DevTools
protocol using only Node's standard library, so it needs no `npm install` and keeps working on a
machine that has never run one.

The second suite has an opt-in live probe that checks the deployed database really does expose an
orderable created column on every table:

```bash
node Everything/tests/ui-structure.test.mjs --live
```

They live in `Everything/tests/`, deliberately outside `api/`, because every file in `api/` is
built as a Vercel function and the project is already at the Hobby plan's 12-function limit.

## The mixed `created` / `created_at` schema
The original prototype tables use `created`; the later foundation tables use `created_at`, and the
deployed database has both. Read routes therefore resolve the column through `createdColumn()` in
`api/lib/auth.js` rather than hardcoding a name — ordering by a column a table lacks is a `42703`
error, not an empty result, which is what produced the 500s on `/api/projects`, `/api/goals`,
`/api/people` and `/api/household-members` (plus a 400 from the browser's own Supabase fallback).

Do not "fix" this by renaming a column. Run the `--live` check to see the real shape first. If a
table genuinely has no created timestamp, the routes skip ordering and still return rows.

## Database
Run the SQL files in `supabase/migrations/` (Supabase dashboard → SQL editor, or
`supabase db push`) before deploying:

| Migration | What it adds |
| --- | --- |
| `001_add_items_completed_at.sql` | `items.completed_at` — a real completion timestamp |
| `002_foundation_entry_model.sql` | Entries, tasks, people, projects, and goals |
| `003_household_workspace.sql` | Households and household memberships |
| `004_reminder_delivery.sql` | `items.reminder_at/notified_at/snoozed_until`, `push_subscriptions`, `notification_log` |
| `005_idempotent_client_ids.sql` | Stable client IDs, authenticated API persistence, and structured-record RLS |
| `006_task_workflow.sql` | Task workflow statuses, checklist steps, and stable recurrence keys on `items` and structured `tasks` |
| `007_smart_capture.sql` | Smart-capture source text, extraction metadata, and duplicate fingerprints on `items` |
| `008_morning_digest.sql` | `digest_preferences` — the opt-in that lets the **server** send the daily digest to a closed app. No row means off, so this is the only migration the Review and digest work needs. |

`supabase/reminder-cron.sql` is **not** a migration — it is the optional minute-level trigger
described under *Cron cadence*, and only needs running if the project stays on Vercel Hobby.

The client probes for `items.completed_at` and the Phase 3 smart-capture columns at sign-in, and only sends those fields when the columns exist, so the app remains usable on a database that has not yet run the latest migration.

Person contact details (phone, email, birthday) need **no migration**. The people table stores only a
name and notes, so `buildStructuredRecordPayload()` puts the details inside the `metadata` jsonb column
the structured-record routes already accept, and `normaliseStructuredRecord()` lifts them back out on
read. A field hung directly on the record would be dropped by the server on the way out and gone by the
next load, with no error to show for it.

A goal's **target date** works the same way. `goals` has a title, description, status and metadata, but
no date column, so the date travels as `metadata.targetDate` and is lifted back out on read. It is typed
as `YYYY-MM-DD`, and a day that does not exist — 2026-02-31 — is refused rather than silently rolled
into March by the `Date` parser.

The *item* side of a goal link stays on the item: `itemSnapshot()` (what the offline queue and the JSON
backup hold) and the `metadata` of the entry and task drafts, which is where the project and person tags
already travel. It is deliberately **not** added to the flat `items` row — that table has real `person`
and `project` columns but no `goal` one, and PostgREST rejects the whole upsert over a single unknown
column. As with the project and person tags, the app restores an item's links from its own local store
rather than re-deriving them from the `items` table.

The household API is used first during sign-in to find or create the current workspace.
The browser still falls back to direct Supabase household access when the API is not
available, so the prototype remains usable before deployment.

The AI endpoint (`/api/ask`) only works when served with Vercel functions
(`vercel dev`) or on a deployed Vercel project, and needs one model provider key.

### Ask / Search model provider
`/api/ask` is provider-agnostic. Set a key and it works; set `AI_PROVIDER` to pin a specific
one. Switching provider or model is an environment change only — no new code, and no extra
serverless function (the adapter lives inside `api/ask.js` because `api/` is already at
Vercel Hobby's 12-function limit).

| `AI_PROVIDER` | Key variable | Model variable | Default model |
| --- | --- | --- | --- |
| `groq` | `GROQ_API_KEY` | `GROQ_MODEL` | `openai/gpt-oss-120b` |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` | `gemini-flash-latest` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-4o-mini` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_MODEL` | `openrouter/free` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |

Groq and Gemini both have usable free tiers and need only their single key variable. Three
caveats worth knowing before choosing:

- **Groq free plan** allows 30 requests/min, 8K input tokens/min and 1K requests/day, and it does
  *not* include `llama-3.3-70b-versatile` (that is an Enterprise model) — hence the
  `openai/gpt-oss-120b` default. The 8K token cap is the binding constraint, so the app sends at
  most 10 context items and only calls the model for queries that read as questions.
- **Gemini free tier** is limited on RPM, TPM and a daily (RPD) quota that resets at midnight
  Pacific. An exhausted key returns `429`, which is a quota state rather than a misconfiguration,
  and it recovers on its own.
- **Neither provider is assumed healthy.** One that just failed is skipped for five minutes, and
  `GET /api/health?probe=1` reports the intended provider next to the one that actually answered,
  so a dead primary cannot hide behind a working fallback.

Gemini is listed first, because its token allowance is the larger of the two, and smart capture
spends the same model on extraction as well. Groq is the automatic fallback; to make it primary
instead, set `AI_PROVIDER=groq` in Vercel.

### Reasoning models and the empty 200

Both free defaults are *reasoning* models, and they can each return **HTTP 200 with no text at
all** rather than an error. This is not a provider outage and nothing in the status code points at
it, so it is worth stating plainly:

- **Groq `openai/gpt-oss-120b`** emits a `reasoning` field before `content`, and with a tight
  budget every token can land in `reasoning`. The adapter reads all the places text can appear, and
  sends `reasoning_effort: "low"` for GPT-OSS models only.
- **Gemini 2.5+** counts thinking tokens against `maxOutputTokens` — Google documents that
  *"because `max_output_tokens` applies to the combined total of thinking tokens and output
  tokens, setting a low limit can truncate responses"*. A short probe can therefore be answered
  entirely in thought. The request sets `generationConfig.thinkingConfig.thinkingBudget = 0`
  (nested inside `generationConfig`, not beside it), which suits this app: it only ever asks
  short, structured, fact-retrieval questions, where reasoning buys nothing.

This is why the cheap `?probe=1` check exists. It catches both failures in about a second, and the
shape report it returns on an empty 200 now carries `finishReason` and the `usage` token counts —
`MAX_TOKENS` with `thoughts` spent and `output: 0` is the signature of a budget problem rather
than a dead provider. Only key names, counts and finish reasons are ever reported; no response
content and no key material.

**The model is a bonus, not the engine.** The ranked local search scores title, whole phrase,
aliases, status and due date across every field, so a plain lookup ("gym") is answered instantly
from local data with no network call and no quota spent. Only a query that reads as a question
("when is the invoice due") spends a completion, and never more than once every six seconds.

`OPENAI_BASE_URL` overrides the base URL for any provider, so any OpenAI-compatible host
also works. `GET /api/health` reports `aiAvailable`, `aiProvider`, `aiModel`, `aiFallbacks`,
and a plain-language `aiMessage` (never any key value). With no key configured, Ask shows
your matching items plus a one-line note, instead of an error.

### Diagnosing a search that "is not working"

Check these in order — the first one that fails explains it:

1. `https://<your-project>.vercel.app/api/health?probe=1` — `aiProbe.ok` proves a real
   completion came back, not just that a key exists. `provider` shows who actually answered.
2. `aiProvider` — if it is not the one you expect, `AI_PROVIDER` is pinned in Vercel and
   overrides the built-in order.
3. A bare `POST /api/ask` returns **401 Authentication required**. That is correct: the route
   requires a signed-in Supabase token, so this is how you confirm the route is live without
   a session. It is *not* evidence that search is broken.
4. In the browser, the AI line under the search box names the failure, e.g.
   *"(groq:429 -> gemini:timeout)"*. That trail is appended by `readAskError()` and is the
   fastest way to see a real cause without opening DevTools.

### Automatic fallback
If you configure **more than one** key, Ask walks them in order and moves to the next one
whenever the current provider is rate limited (429), out of quota (402), timing out, or
returning an empty answer. `AI_PROVIDER` pins the *primary* but does not disable the
fallbacks — being rate limited is no reason to break Ask. Bad keys (401/403) and malformed
requests (400) are never retried, because they would fail identically everywhere.

Each attempt is capped at 8 seconds so two sequential calls cannot exceed the serverless
function budget, and a successful answer is returned as soon as it arrives — there is no
extra latency when the primary works. `/api/ask` also returns `provider` and `model` so you
can see which one actually answered.

> Fallback only covers *provider* failures. If you exceed a token limit on every configured
> provider, Ask falls back to local keyword results.

## Inline help

A field whose meaning is not obvious gets an **"i"** beside its label. Tap it and a note explains
what the field actually does; tap again, press Escape, or tap anywhere else and it goes away. The
notes answer the question the field does not answer on its own — *what does "Repeats" do when I
finish the task?* — rather than restating the label.

**Hover is not enough, and that is the whole design problem.** This app is mostly opened on a
phone, where there is no `mouseenter` at all. So the two cases are split on purpose: `:hover` is
applied only inside `@media (hover: hover) and (pointer: fine)`, and the tap-to-toggle works
everywhere. Without that split, tapping on a touch device leaves the element in a stuck `:hover`
state and the bubble never closes.

Three details that were wrong first and are easy to get wrong again:

- **Clicking the icon shut has to beat `:hover`.** On a desktop the pointer is still resting on the
  dot, so a plain close is invisible and the control feels broken. `.is-dismissed` holds it shut and
  is lifted when the pointer leaves.
- **`--tip-shift` is declared on `.info-tip`, not on the bubble.** The bubble is what moves, but
  `positionTip()` writes the value to its parent — and a custom property declared *inside* the
  bubble would shadow the inherited inline value, leaving the edge clamp silently inert.
- **The tail travels with the bubble.** Nudged inwards to stay on a 390px screen, a tail left at
  `left: 50%` would point at empty space.

The notes themselves live in one `FIELD_HELP` map in `script.js`, keyed by control id, so the copy
can be reviewed in one place and a field can never carry a tip describing something else. The
bubble is built from design tokens, so it reads correctly in all ten themes with no per-theme rule.

`help-probe.mjs` drives the real thing: it asserts the bubble is genuinely **visible** (opacity and
`visibility`, not merely present in the DOM), that a second tap closes it, that Escape and an
outside tap close it, that only one is ever open, that it fits a 390px screen when tapped on a
phone, and that its own text clears 3:1 on its own background in every theme. A probe that only
checked the CSS existed would pass while nothing was ever visible to anyone.

**Side effect worth knowing:** the labels for these fields had no `for`, so they were not associated
with their controls at all — clicking a label did not focus the field, and a screen reader had no
name for it. Eighteen labels are now associated, which is an accessibility fix independent of the
tooltips.

### The server leg — reaching a phone with the app closed

The client digest fires when the app is open, or has been opened that day. That is not good enough:
the whole point is to be told what needs you *without* having to go and look. The digest now also
runs from `api/send-due-notifications.js`, which is the only moment the server is awake.

It obeys the **same rules**, deliberately duplicated rather than shared: same three counts, same
"say nothing when there is nothing to say", same *do not mark the day when nothing was sent*, and the
same notification `tag`, so a server digest replaces a client one instead of stacking a second
identical notification underneath it. If the two legs disagreed, the app would argue with itself about
whether a day was worth mentioning.

Four things the server leg has to get right that the client never had to:

- **Per-user, not per-household.** The digest says *"you have three overdue"*. Your partner's overdue
  items are not yours to be nagged about, so the query filters on `owner_id` and pushes only to that
  person's subscriptions.
- **Local hour, local day.** 8am UTC is 3pm in India. A digest at 3am is how a feature gets muted for
  good, so the once-a-day key is computed in the subscriber's own timezone, taken from the `timezone`
  column `push_subscriptions` already stored. The hour is a **waking window (06:00–20:00 local), not
  a target hour** — see below for why.
- **A quiet day does not mark the day.** Same rule as the client, so something that becomes due later
  that day is still mentioned.
- **A failed push does not mark the day**, so the next cron run retries instead of skipping the day.

`digest_preferences` (migration `008`) is the opt-in: **no row means off**, and a database without the
table degrades to silence rather than erroring every hour. Its RLS policy lets a person read and write
their own row and nobody else's; the cron uses the service role. The client syncs the preference on
every toggle, best-effort — if migration 008 has not run, the client leg still works and logs a note.

### The hour is a window, not a clock — and why

The first version asked the server for *"8am, in the user's timezone."* That can never work on this
deployment, and would have shipped as a feature that silently never fires.

**Vercel Hobby allows one cron run a day**, and this project's runs at **01:00 UTC**. That is:

| where you are | 01:00 UTC is | would a digest arrive? |
| --- | --- | --- |
| California | 17:00 the previous day | yes, but at 5pm |
| London | 01:00 | **no — the middle of the night** |
| India | 06:30 | borderline |

So the server sends inside a **waking window of 06:00–20:00 local**, and stays silent outside it. For
India that means 6:30am, which is reasonable; for London the single daily run falls at 1am and is
correctly **declined** rather than delivered.

Being declined is the right outcome, and the day is deliberately **not** marked as sent, so a later
run can still deliver. If you run the minute-level schedule in `supabase/reminder-cron.sql` (the
documented Hobby workaround), the window is hit reliably and the digest effectively lands at the hour
you chose in Settings. Until then, treat the server leg as *best effort*, and the client leg — which
does honour your exact hour — as the dependable one.

## Review — the missing half of the loop

Capture, clarify and next-action all work. **Reflect** did not exist, and that is the half of the
loop that catches drift before anything has to remind you. A new **Review** view, next to Reports and
Insights.

Reports and Insights were both already there, and both are **history** — what you did. Review is the
present tense: what is stuck *right now*.

| section | what it answers |
| --- | --- |
| **Needs a decision** | what is overdue, or waiting too long — with *why*, and by how much |
| **Finished this week** | what you actually got done |
| **Quiet projects** | where nothing has moved for a fortnight |
| **No next step** | open work with no day and no rhythm, so it can never surface on its own |

### It says why, not just what

*"Overdue by 3 days"* and *"Waiting 12 days with no check-back"* rather than a bare list, because the
reason is what tells you whether to **do it, move it, or drop it** — and that choice is the entire
point of a review.

### It is allowed to say nothing

A review that always finds something is a review people stop opening. A clean week reads *"Nothing is
stuck. That is a good week."* and an empty account gets an honest page rather than a wall of zeroes.

It is built from `created`, `done` and `dueDate` alone, reuses the same `isOverdue` as the rest of the
app, and works offline for free. A **recurring** task is never counted as having no next step — a
weekly task has a rhythm already, and nagging it for a date too would be pressure, not help.

`review-probe.mjs` checks it says something *true*: that an overdue task and a stale waiting item are
both reported with the right reason, that a clean week and an empty account are both reported
honestly, that a completion from a month ago is not counted as this week, that a quiet project is
named while a moving one is not, and that a title containing an apostrophe and quotes cannot break
the row.

## Share target — capture from any app

Smart capture is only useful if you can reach it at the moment the thought arrives. Dictation was
that moment on a phone; **sharing is that moment in every other app.** Share a message, a page, or a
photo to Everything, and it lands in the capture sheet.

```json
"share_target": { "action": "./?share=1", "method": "POST", "enctype": "multipart/form-data" }
```

### It is captured and *read*, not just filed

Shared text goes through `onCaptureInput()` — the same entry point as typing and dictation. So
sharing **"call Ravi tomorrow"** from a chat arrives as a **task with a person and a date**, exactly
as if you had typed it. Routing it anywhere else would make sharing a second-class way to capture,
which defeats the point of adding it.

A shared page arrives as a title *and* a URL, and both are joined: reading only the title would
throw the link away. The URL is then placed in the link field, where it is validated as a URL.

A shared **photo** is counted and reported, not kept. Holding the bytes in Cache Storage would pin a
photo per share, so instead the capture sheet says one was shared and lets you attach it through the
normal picker — which keeps the OCR path, the upload and the reading all on their existing,
tested rails.

### The two non-obvious parts

**A share is a top-level navigation, not a fetch.** The OS opens the app *at* the share target and
POSTs to it, and a POST has nowhere to render. The service worker intercepts it, stashes the fields
in Cache Storage, and answers `303` to `./?share=1`; the browser then makes a real GET and the page
loads on that URL. The first version of the probe used `fetch()`, which followed the redirect
silently, left the page on its old URL, and never ran the collection code at all — a green test for
a completely dead feature. The probe now submits a **real form**, because that is what the OS does.

**A share is collected exactly once.** The worker deletes the entry as it replies, so a reload finds
nothing. Without that, every reload would reopen the sheet with the same words — a very annoying way
to lose a reload.

### The cache trap

A share target added without bumping the shell cache is **invisible to anyone who already installed
the app**: the worker keeps serving the old manifest and the OS simply never offers to share. It
looks broken on a phone and fine on a laptop. The probe asserts the *cached* manifest is current,
not just the one on disk, so this cannot regress quietly.

`share-target-probe.mjs` drives the real worker with a real form navigation at 390px: that the
manifest declares a POST share target, that the shell cache carries it, that a shared sentence is
read into the sheet, that a shared link keeps its URL, that a reload does not replay it, and that
sharing nothing does not open a blank sheet.

## The morning digest

The app was **pull-based only**: you open it, and it tells you what's on. That works right up until
the thing you needed was the reason you forgot to open it. The morning digest is the one thing that
speaks first — one notification a day, at a time you choose, saying what actually needs you.

> **Good morning · 2 overdue · 3 due today**
> Call the bank · Send the invoice · Book the dentist · and 2 more

It counts three things:

| | |
| --- | --- |
| **overdue** | open work whose day has passed |
| **due today** | open work due now |
| **waiting too long** | a `waiting` item with no check-back day after **14 days** |

That third one is the case a pull-based view never surfaces. It is not overdue, not due today, and
not in anybody's way — it is simply the thing you asked someone for and then never chased. It is
also the item most likely to be forgotten entirely.

The counts reuse the same `isOverdue` and `isToday` as the Today view and the notification bell, so
the digest can never disagree with the rest of the app about what is late.

### It is built to stay quiet

A daily notification is the easiest thing in this app to get wrong. Get it wrong once and it is
muted for good — and **a muted digest is worse than none**, because it is exactly the "pressure"
the rest of the app works to avoid. So four rules, each one enforced and each one tested:

- **Off by default.** Nothing is sent until you switch it on.
- **Silent before your hour.** Never at 2am because the default is 8am.
- **Silent when there is nothing to say.** `buildMorningDigest` returns `null` and no notification
  is produced. A quiet day really is quiet.
- **Never twice in a day**, and one tag, so a second send replaces the first rather than stacking.

**It says little, and names the worst first.** At most three names, then *"and 2 more"*. Overdue is
ranked ahead of merely due today, because the worst thing is the reason to read the rest.

### A detail that turned out to matter

When there is nothing to report, the day is **not** marked as delivered. The first version did mark
it, to avoid rebuilding an empty digest every 30 seconds — but that would suppress the rest of the
day, so a task snoozed to this afternoon would never be mentioned. Rebuilding an empty digest costs
one array filter; losing a real item to save that is a bad trade.

### Seeing it before you trust it

Settings → Notifications has a toggle, an hour picker, and **"See what it would say"** — which
shows a real notification with the real text, without sending the day's digest and without marking
today as done. So it can be tried at any hour, as often as you like. The status line states the
content out loud:

> *On. Today it would say: "Good morning · 2 overdue — Call the bank · Send the invoice". One
> message a day, never more.*

A daily notification with no stated content is how a feature gets switched off in week one and never
turned back on, so the settings copy always says what it will do.

Tapping the digest opens **Today**, where everything it lists already lives. That needed a
`?view=today` deep link, added to the existing `?item=` / `?notifAction=` handler.

### What it does not do

- **The digest is built on the client**, from the items the app has loaded. It therefore fires when
  the app is open or has been opened that day. Items with a real reminder time are still delivered
  by the service worker and the server cron with the app genuinely closed; the digest is not, yet.
  Making it work fully closed means computing it in `api/send-due-notifications.js` from Supabase
  and pushing to every device — the push machinery is all there, the query is not.
- The **server** would need the same "stay quiet" rules, or it would disagree with the client about
  whether a day is worth mentioning.
- Per-user preference is `localStorage` on one device. A phone and a laptop each keep their own
  setting, and only one of them sends.

`morning-digest-probe.mjs` is mostly about silence: that a quiet day returns no digest at all, that
it stays quiet before the chosen hour and when switched off, that it never sends twice, and that a
day with nothing to do is not recorded as a day it was sent. Then, only once it has proved it can
stay quiet, that it counts correctly, ranks overdue first, and names at most three things.

## Next-step suggestions, and learning from being turned down

Open an item and, when there is an obvious thing to do with it, the app offers it — *"This has no
day on it, so it cannot surface on its own"* — with a tap to do it and a cross to refuse it.

**Nothing is ever done for you.** Every suggestion is a button. That is the same rule the rest of the
app already follows: *suggestions, not pressure*. The card is one line of reason plus one to three
buttons, and it disappears the instant it no longer applies — never an empty bordered box.

### The three rules

Each was chosen because it is right far more often than not, **and** because it can be checked
against facts already in the app rather than guessed at:

| rule | fires when | offers |
| --- | --- | --- |
| `set-date` | an open **task** or **waiting** item with no day, and no recurrence | Today · Tomorrow · Next week |
| `link-person` | someone you already track is named in the text but never linked | *Link to Ravi* |
| `recur` | you completed this exact job before and it used to repeat | *Make it weekly* |

Two deliberate quiet spots:

- **A task that already repeats** is never asked for a one-off date. A weekly task has a rhythm
  already; asking it for a date as well is nagging, not helping.
- **Completed, archived, and generic titles** never fire `recur`. "Renew passport" recurring is a
  real pattern; "Task" recurring is noise.

Name matching is on **whole words**, so `Ann` does not fire inside *"Anna-Marie"*, and the longest
matching name wins, so *Priya Sharma* beats *Priya*.

### One card, not a stack

When an undated task *also* names an unlinked person, the date wins. A task with no day is the more
urgent gap. A pile of suggestions is just noise, so the rules are ordered by how often they are right
and the first match takes the card.

### Learning from what you dismiss

| you | the app does |
| --- | --- |
| tap it | applies it, and **clears everything it remembered** about that rule |
| dismiss once | shows it again — one refusal usually means *not right now* |
| dismiss twice | **stops offering that rule** |
| …then wait | the memory decays after **45 days** and the rule is allowed back |

The limit is two, not one, because a single dismissal is almost always *"not right now"* — the same
item tomorrow may well need a date. And suppression is **not permanent**: a bad month should not
silence a useful suggestion for the rest of the year, so each turn-down loses its weight after 45
days. Acting on a suggestion clears the record outright, so someone who took the advice and took it
again is never asked to stop.

It is stored in `localStorage` under `everything_next_action_learning_v1`, keyed by rule id. In
private mode the suggestion still works — it just cannot remember.

### Accessibility and touch

- The dismiss control is a real `<button>` with a real label — *"Dismiss this suggestion and stop
  showing it"* — because an unlabelled cross does not convey the promise the feature makes.
- It grows from 30px to **44px** at 480px and below, so on a phone it is a tap and not a miss.
- Styling is token-only, so it is legible across all ten themes with no per-theme rules.

`next-action-probe.mjs` drives the real engine against real seeded items and reads the real DOM:
that the card appears and hides correctly, that a tap actually applies and the card moves on, that
one dismissal does not silence it and two do, that a 60-day-old turn-down is forgotten while a
2-day-old one is respected, that taking a suggestion clears the memory, that `Ann` does not match
`Anna-Marie`, that the more urgent rule wins, and that the dismiss target clears 44px at 390px.

## Voice and images are read, not just stored

Dictation used to **record and stop**. The transcript was written into the box, the local rules and
the model read the text, and then the whole result was thrown away — the capture stayed kind
`voice` forever. A dictated *"call Ravi tomorrow"* became a voice note, never a task, never on a
schedule, never anything the rest of the app could act on. A picture of a bill was the same.

**The cause was one variable doing two jobs.** `captureType` held both *how the capture arrived*
(voice / image / file / link) and *what it turned out to be* (task / event / …). Because the kind was
occupied by the channel, every rule in the smart-capture path had to skip media captures entirely —
in four separate places — and an auto-create could never fire for one. The guards were not
accidents; they were the only way to keep the audio from being dropped when the kind was read as a
task.

They are now two variables:

| | decides | changed by |
| --- | --- | --- |
| `captureChannel` | how the capture is handled: upload the audio, keep the transcript, show the recorder | only the person, by picking a media chip |
| `captureType` | what the item **is** | the person, **or** the reader |

So a dictated *"call Ravi tomorrow"* is a voice capture that **is** a task: the audio still uploads,
the transcript is still kept, the recorder stays on screen, and the item lands in Tasks. The same
holds for text read out of a picture.

**A file and a link are deliberately left alone.** There is nothing inside a file to read, and a
link's "text" is a URL — asking a model to interpret either would be guessing. They keep their own
kind.

### The detail that was still wrong after the first fix

Picking the **Voice** chip used to set `captureAutoDetected`, the flag meaning *"the person has
already chosen the kind, do not read it again."* But choosing Voice says how the capture arrived,
not what it is. The reader was being told the kind was settled, and duly did nothing. Only a
**kind** marks a settled decision now — a manual choice is still never overridden, and
`voice-understanding-probe.mjs` checks exactly that.

`voice-understanding-probe.mjs` drives the real functions in a real browser, with a real transcript
and no model and no network, because the local rules are what decide a plain sentence. It asserts
the person and the date are picked out, that no dictation ever survives as kind `voice`, that the
recorder stays visible, that file and link are untouched, that the channel resets between
captures, and that a manual choice is never overridden.

**One thing it does not promise:** the local rules only call something an *event* when it carries
both a time **and** an event word (`meeting`, `sync`, `demo`, …). *"design review tomorrow at 3pm"*
has the time but not the word, so offline it stays a note until the model reads it. That limit
predates this work and is unchanged.

## Note on multi-user sync
The app runs as a static site with Supabase for accounts and shared data, Vercel serverless
functions for the API routes, and any of several model providers for AI. Opened as a plain
`file://` page it still works, but falls back to local-only storage in that one browser, and AI
falls back to keyword matching. A local Ollama model removes the AI dependency entirely — see
*Local model (Ollama)*.

There are two sync paths, and they are not interchangeable. **Supabase** (`sbUser`) loads items,
projects, goals and people and saves each of them back. The **`db` multi-user** path is separate,
and it is easy to extend one collection without the others: a `dbSave*` helper writing to
`db.collection("people")` is not the same as anyone *reading* people back.

That is exactly how **People was half-wired for so long**: `dbSavePerson` and `dbDeletePerson` both
wrote to the shared `people` collection, but `initMultiUser()` only subscribed to `items`,
`projects` and `goals`. A person saved in multi-user mode reached the database and was never
delivered back — not to the person who typed it, and not to anyone else. The state object built
for that path did not even carry a `people` key, so `renderAll()` → `renderPeople()` mapped over
`undefined` and threw on the very first snapshot, taking the item render down with it.

A collection that is written to but never subscribed to is invisible in a way that no screenshot
or happy-path test will show, so the invariant is now asserted rather than remembered:
`ui-structure.test.mjs` **derives** the set of collections from the source, then requires each one
to be opened as a shared collection, subscribed with `onSnapshot`, and present as a key in the state
that path builds. Adding a fifth collection without wiring it up fails the suite.

The same reasoning is why `dead-code-audit.mjs` exists, and why it runs as a suite (`npm test` → the
`deadcode` row). Anything that merely looks plausible — a function nothing calls, a class nothing
applies, a route the client never requests, an npm script pointing at a deleted file — is reported
with the counts behind it, so a finding can be argued with instead of trusted. Two details matter:

- **`--debug` is a self-check.** It prints tallies for names that are definitely live. An audit that
  cries wolf is worse than none, because the reader learns to skip it, and that is exactly how a
  real finding gets missed.
- **"used only by a test" is not dead.** A function kept alive by a probe is a reason to keep it. It
  is reported in its own bucket and does not fail the run.

`/api/health` is whitelisted as an operations endpoint. The page never calls it — monitoring, a
deploy check or a person with curl does — so flagging it every run would be noise.

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Initial prototype"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```
