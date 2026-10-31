# On a new machine

A clone has the code, docs and history; the deployed backend and GitHub Pages don't depend
on any laptop. Not in the repo (git-ignored, private or generated), so set up by hand:
- **Tools:** `uv` then `uv sync`; Node, the version in `.node-version` (Homebrew: `brew install node`), then `npm ci`; Google Chrome for the 4 browser tests
  (skipped without it). git push with the AntonMenshov credentials (`gh` is optional); git `user.name` Anton Menshov,
  `user.email` anton.menshov@gmail.com (commits are authored only as the user).
- **Backend profile:** copy `~/.config/chgk/backends.json`, or `uv run chgk backend add personal
  --url <Web app /exec URL> --token <ADMIN_TOKEN>`; the token is in the Apps Script project's
  Project Settings → Script properties. Then `uv run chgk backend check`.
- **`tournaments/*/state.json`:** each tournament's ID, Sheet and jury/board tokens. Copy them;
  without one, chgk treats the tournament as new (a generated ID changes, so old cards no longer match).
- **Private logos:** `logos/*.png` (the user's team logos; without them cards fall back to the
  owl, with a warning) and `logos/drafts/` (the logo test drafts).
- **`ANTHROPIC_API_KEY`** in the shell profile, only for `chgk logos --draw`.
- **Claude's memory** (`~/.claude/projects/…`) isn't needed: everything is in the repo's docs, and
  `CLAUDE.md` points a new session to HANDOVER.
- `out/code-review/` can't be regenerated without a new review: copy it. The rest of `out/` is regenerated: `uv run chgk cards tournaments/osenniy-salat --mode team-pages`,
  `uv run chgk backend bundle`.
