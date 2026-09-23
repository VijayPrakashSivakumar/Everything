# Everything — Prototype

A working prototype of the "Everything" productivity app: capture, tasks,
inbox, calendar, projects, goals, and AI-assisted search.

## Files
- `index.html` — page structure
- `style.css` — all styling
- `script.js` — app logic (local state + optional multi-user sync)
- `sw.js` — service worker (offline shell + push notifications)
- `api/ask.js` — AI search endpoint (`/api/ask`)
- `api/send-due-notifications.js` — Vercel cron that pushes due reminders

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
