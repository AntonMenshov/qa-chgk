# Docs to fix later

From the docs audit of 2026-10-30 (small fixes were applied then). Delete items as they are done.


### SPEC.md
- [high] SPEC.md:§3/§5/§7.2 (no line mentions it) — The backend's Sheets API advanced service (one batched read + one batched write per request, SpreadsheetApp fallback, quota 60/min) and the `timing` object in every reply are not in SPEC at all. Add a short subsection under §5 Rules or §3 (design decision, not a how-to).
- [medium] SPEC.md:221-223 — §7.2 "one Apps Script request takes ~1 s" is only the ping floor; real requests measured 1.6–4.4 s (HANDOVER Lessons). Add the current figures or point to HANDOVER.
- [medium] SPEC.md:410 — `docs/manual-checks.md` is referenced but doesn't exist. Create it (iPhone scanning, print scale/shades, Apps Script quotas/CORS, the two Sheet-trigger checks) or drop the reference.
- [medium] SPEC.md:252-264 — §8.2 card contents: no mention that reserve decks print their ID (R1, …) small and bold bottom right and have a «Команда:» line; footer example `Синие зайцы · Осенний кубок · 15.11.2026` shows the date although it is off by default (CardFields.date=False). Add a reserve-deck bullet and drop the date from the sketch or mark it "(date only with `date=True`)".
- [medium] SPEC.md:56, 424 — deploying "via `clasp` … or by copy-paste" / "pushed with `clasp` or pasted by hand": the actual route is `chgk backend bundle` → paste `out/apps_script/Code.gs` (docs/google-account.md). Mention `backend bundle`, keep clasp as optional.
- [medium] SPEC.md:430 — §13 heading "(planned commands)": these are built; rename to "CLI", add `version`, and fix the `teams` comment ("validate logos" — check whether sync_teams actually validates logos).
- [low] SPEC.md:3 — "Status: draft v1 (2026-10-29)" — update the status/date (phases 0,1,2,5 implemented).
- [low] SPEC.md:93-113 — config example lacks `reserve_teams`, `board_grid_max_teams`, `logo_size`, `fallback_logo`; they're only described elsewhere. Add them with defaults as comments.
- [low] SPEC.md:131 — Settings tab "Who writes: CLI" — it's written by the backend on `create_tournament`. Also the hidden Meta tab has no row in the tab table (only mentioned in §5 Rules).
- [low] SPEC.md:133 — Log columns are out of date/incomplete. Actual (Code.js `LOG_HEADER`): server_time, client_time, scan_id, source, juror, device, team_id, question, spare, status, value, applied, photo.
- [low] SPEC.md:198 — §7.1 says a photo of every card is captured; Phase 4 isn't built. Mark it "(Phase 4)".
- [low] SPEC.md:20 — Rounds range "1–8" isn't enforced (config only checks ≥ 1). Either enforce or call it "typical".
- [low] SPEC.md:292-316 — §8.6 doesn't say the date is in the page titles and every footer (342563a).
- [low] SPEC.md:140 — overlong line (re-wrap only).
- [low] SPEC.md (6×) vs SPEC.md:132, HANDOVER, code — "organizer" vs "organiser"; code and HANDOVER use "organiser". Pick one (British matches "centred", "colour" used elsewhere).
- [low] SPEC.md:442-447 vs HANDOVER.md:170-173 — open-items lists differ (SPEC: spares [3], photo retention, fill team-pages slots; HANDOVER: board freeze, photo retention). Keep one list (SPEC) and point to it.

### PLAN.md
- [medium] PLAN.md:94 and HANDOVER.md:172, 194 — "freeze-standings option on the board" / "Projector board freezes during the last round: no" conflict with SPEC §14 item 2 (decided: board shown only after each round, revealed by hand). Drop it from PLAN Later, HANDOVER open item 1 and next step 6.
- [medium] PLAN.md:82 — Phase 5 "live standings" contradicts the reveal-by-hand board (SPEC §10.1). Reword to "standings of revealed rounds".
- [medium] PLAN.md:3-6 — phase-done checklist lacks lint/format (ruff, ESLint + Prettier) which CI now enforces.
- [low] PLAN.md:28 — "Teams come from a local CSV fixture" → teams.py (04ec12b). Historical, but confusing.
- [low] PLAN.md:40-41 — Phase 2 lists `upload_photo` (Phase 4, not built) and "Sheet from template" (Sheet is built programmatically); actual actions also include set_teams, get_results, get_board, set_board_token, share_view.
- [low] PLAN.md:50 — "clasp `--user` profiles, or copy-paste" → `chgk backend bundle` + paste.
- [low] PLAN.md — no per-phase status; fine if HANDOVER is the only status source, but say so in one line.

### HANDOVER.md
- [high] HANDOVER.md:313-361 — "Things that need the user" is a chronological log of finished live checks (versions 1ba5289567d9, 9a067acc3aed, eb1607f87ed2, …). Trim to real open items: iPhone test (incl. «Чья карточка?»), the two Sheet-trigger checks, a real print, delete `spike.jpg`; move the history to a short "Live checks" note or drop it. Line 316 still says "now version 1ba5289567d9"; line 347 says "board QR on page 1" (now page 2).
- [high] HANDOVER.md:17-28 — the currently deployed backend version (890a366d62b5) appears only deep in Lessons (line 214); Phase 5 row cites 6db9ad957009. Add one "Deployed backend: 890a366d62b5" line to Current state.
- [medium] HANDOVER.md:359 — "Delete the old example folder 5R547" is probably done (line 332: "the user trashed the old folders"). Confirm and remove.
- [medium] HANDOVER.md:196-238 — "Lessons learned" starts with feature decisions/status (Board, Backend speed, «Спорные», Cards date/reserve ID/centred logo, «Чья карточка?», jury sheet pages). Move these to Key decisions (which lacks «Спорные», view-only link/`chgk view`, Sheets API backend, card date off, reserve-deck ID) and keep Lessons for lessons.
- [medium] HANDOVER.md:202, 220 vs 185-187 — proposal numbering disagrees: next step 2 lists timings/batched API/cache/formulas (#1–#4), Lessons calls the Sheets API "#3" and the cache "#2". Use one numbering.
- [medium] HANDOVER.md:179-187 — next step 2 is mostly a done profiling report; once the in-progress work (lazy open, one-call sort) lands, replace with the remaining proposals only.
- [medium] HANDOVER.md:78-84 — How to run lacks `chgk new`, `chgk teams`, `chgk board`, `chgk view`, `chgk backend check`, and the lint commands (they're only in Working conventions).
- [low] HANDOVER.md:79-80 — test counts stale: "384 pass" / "148 pass"; now 401 pytest collected, `npm test` 179 + 65 (backend suites rerun with the Sheets API off). Update when the in-progress work is committed.
- [low] HANDOVER.md:53-63 — tests list misses several files (test_jury.py, test_cli.py, test_toolchain.py, logic/backend/vectors .mjs …), and eslint.config.js/.prettierrc.json aren't in the layout. Either list all or say "e.g.".
- [low] HANDOVER.md:191 — next step 5 "organiser README" — no README.md exists at the repo root (see below).

### docs/google-account.md
- [medium] docs/google-account.md:50-56 — "Use it" lacks `chgk board` (projector link), `chgk view` (view-only link for older tournaments) and `chgk jury-sheet`.
- [low] docs/google-account.md:70-78 — §4 Update: mention that a backend first deployed before the Sheets API service existed should add it now (Services + → Google Sheets API) — `chgk backend check` already warns.

### docs/spikes.md
- [low] docs/spikes.md:50 — "see HANDOVER.md, 'Things that need the user'" — that section no longer covers the spike pages/HTTPS. Point to the Pages URL instead.
- [low] docs/spikes.md:83 — result "3%" without a note that it was later changed to 12% (SPEC §8.2); add "(later 12%, see SPEC §8.2)".

### Missing docs
- [medium] README.md at the repo root — none exists. Organiser end-to-end: deploy backend (link docs/google-account.md) → config.py/teams.py → `chgk new` → `chgk cards` → print → game day (scanner, board, view-only link, «Спорные») → `chgk teams`/`view`/`board`. Also covers lint/test commands for contributors.

### Outside doc scope (for the code owner)
- [low] tournaments/example/config.py:23 — comment "about the largest that fits a 3×5 card left of the QR" is stale since the logo is centred; max is now ~1.96 in.

### Memory
- [low] regenerate-outputs-without-asking.md — frontmatter lacks the `node_type`/`originSessionId`/`modified` metadata the other three have; harmless, align if the format matters.
- Otherwise all memories are still true; no duplicates; MEMORY.md lists all 4 files.

### Checked and fine
- package.json and pyproject.toml descriptions/comments; web/s/vendor/README.md (file names match); tests/vectors/README.md; relative links PLAN↔SPEC↔HANDOVER; Sheets API setup step in docs/google-account.md §1.4; SPEC §5 tab names («Итоги», «Тур N», «Статистика», hidden «Спорные»/Teams/Log/Settings/Meta); SPEC §7.1 «Чья карточка?»; spare-card prompt text «Запасная карточка — какой вопрос?» matches web/s/index.html; no "Запасной" label or manual question picker left in docs.
