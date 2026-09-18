# Everything — Prototype

A working prototype of the "Everything" productivity app: capture, tasks,
inbox, calendar, projects, goals, and AI-assisted search.

## Files
- `index.html` — page structure
- `style.css` — all styling
- `script.js` — app logic (local state + optional multi-user sync)

## Running it locally
This is a static site — no build step needed.

```bash
# Option 1: just open it
open index.html

# Option 2: serve it (recommended, avoids browser file:// restrictions)
python3 -m http.server 8000
# then visit http://localhost:8000
```

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
