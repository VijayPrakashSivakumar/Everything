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
- `vercel.json` — declares that cron (also kept in `api/vercel.json`; see *Cron cadence*)

## Features
- **Capture** — text, voice, image, file and link captures, with type detection and
  natural-language extraction ("call Ravi tomorrow at 5pm" fills person, due date and type).
- **Views** — Today, Inbox, Tasks, Schedule (week/month), Memory, People, Projects,
  Goals, Reports and Insights.
- **Ask / Search** — `Ctrl/⌘ + K` or `/` opens search, which answers questions via
  `/api/ask` (Claude) and falls back to keyword matching offline.
- **Quick reschedule** — open any item and use *Reschedule* (Tomorrow 9 AM, +1 day,
  +1 week, clear) instead of editing the date by hand.
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

```bash
# Option 1: just open it
open index.html

# Option 2: serve it (recommended, avoids browser file:// restrictions)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Database
Run the SQL files in `supabase/migrations/` (Supabase dashboard → SQL editor, or
`supabase db push`) before deploying:

| Migration | What it adds |
| --- | --- |
| `001_add_items_completed_at.sql` | `items.completed_at` — a real completion timestamp |
| `002_foundation_entry_model.sql` | Entries, tasks, people, projects, and goals |
| `003_household_workspace.sql` | Households and household memberships |
| `004_reminder_delivery.sql` | `items.reminder_at/notified_at/snoozed_until`, `push_subscriptions`, `notification_log` |

`supabase/reminder-cron.sql` is **not** a migration — it is the optional minute-level trigger
described under *Cron cadence*, and only needs running if the project stays on Vercel Hobby.

The client probes for `items.completed_at` at sign-in and only sends it when the column
exists, so the app keeps working on a database that hasn't been migrated yet (Reports
then falls back to a per-device completion log in `localStorage`).

The household API is used first during sign-in to find or create the current workspace.
The browser still falls back to direct Supabase household access when the API is not
available, so the prototype remains usable before deployment.

The AI endpoint (`/api/ask`) only works when served with Vercel functions
(`vercel dev`) or on a deployed Vercel project, and needs an `ANTHROPIC_API_KEY`.

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
