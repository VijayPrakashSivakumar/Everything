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
  plus duplicate-capture protection.
- **Views** — Today, Inbox, Tasks, Schedule (week/month), Memory, People, Projects,
  Goals, Reports and Insights.
- **Ask / Search** — `Ctrl/⌘ + K` or `/` opens search, which answers questions via
  `/api/ask` (any supported model provider) and falls back to keyword matching offline.
- **Quick reschedule** — open any item and use *Reschedule* (Tomorrow 9 AM, +1 day,
  +1 week, clear) instead of editing the date by hand.
- **Task workflow** — tasks support Planned, Today, In progress, Waiting, Someday, and Completed states, with a Priority view, persisted checklist steps, quick conversion, duplication, rescheduling, priority-aware ordering, and reversible Archive/Restore.
- **Reports** — 14-day chart of captures vs completions (completions are logged locally).
- **Backup** — Settings → Account → *Export backup* / *Import backup* (JSON round-trip).
- **Keyboard shortcuts** — `Ctrl/⌘ + K` search, `C` quick capture, `/` focus search,
  `Esc` close the top-most dialog.
- **Installable PWA** — offline shell via `sw.js`, plus web-push reminders.
- **Reminders that arrive offline** — see *Reminder delivery* below.

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
about what matches.

## Back gesture on mobile
A history entry is pushed while a dismissible layer is open (Capture sheet, Ask overlay, item
panel, sidebar, or the search dropdown) and popped when it closes, so Android's back swipe
always closes the top layer rather than walking out to the previous page. With nothing open,
back is left to the browser, which backgrounds the app. A page cannot close its own tab, and
holding a permanent guard would trap the user on the site, so that is deliberately not done.

## Tests
The suites run offline — no API key, no login, no network:

```bash
node Everything/tests/ask-adapter.test.mjs   # provider fallback, shared budget, reason trail
node Everything/tests/ui-structure.test.mjs  # search wiring, mobile layout, back guard, schema
```

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

`supabase/reminder-cron.sql` is **not** a migration — it is the optional minute-level trigger
described under *Cron cadence*, and only needs running if the project stays on Vercel Hobby.

The client probes for `items.completed_at` and the Phase 3 smart-capture columns at sign-in, and only sends those fields when the columns exist, so the app remains usable on a database that has not yet run the latest migration.

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

Groq and Gemini both have usable free tiers and need only their single key variable. Two
caveats worth knowing before choosing:

- **Groq free plan** allows 30 requests/min and 8K input tokens/min, and it does *not*
  include `llama-3.3-70b-versatile` (that is an Enterprise model) — hence the
  `openai/gpt-oss-120b` default. Because of the token cap, Ask sends at most 30 items with
  each field truncated to 120 characters.
- **Gemini free plan** has a far larger token allowance, so it is the better default if you
  expect to ask questions with a lot of history.

`OPENAI_BASE_URL` overrides the base URL for any provider, so any OpenAI-compatible host
also works. `GET /api/health` reports `aiAvailable`, `aiProvider`, `aiModel`, `aiFallbacks`,
and a plain-language `aiMessage` (never any key value). With no key configured, Ask shows
your matching items plus a one-line note, instead of an error.

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

## Note on multi-user / private items / AI search
The live multi-user sync, private-per-person data, and AI-powered search
features rely on capabilities only available when this app runs inside a
published Claude artifact (claude.ai). Opened as a plain static site, the
app still works, but falls back to local-only storage in that one browser,
and AI search falls back to simple keyword matching.

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Initial prototype"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```
