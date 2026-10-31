# Implementation plan

See [SPEC.md](SPEC.md). Which phases are done is tracked only in
[HANDOVER.md](HANDOVER.md) ("Current state"). Each phase ends with:
- its unit tests passing (`uv run pytest`, and `npm test` where JS is involved);
- lint, format and types clean (`uv run ruff format . && uv run ruff check . && uv run mypy`,
  `npm run format && npm run lint && npm run typecheck`), as CI checks;
- a commit on `main`;
- [HANDOVER.md](HANDOVER.md) updated in the same commit.

Tests are written alongside the code, not after it.

Phases 0-6 are built; their task lists are in the git history.

## Phase 7 — Internal test at home, with printouts
- Starts with the checks in docs/manual-checks.md, all but the logo drawing ones (the user's
  manual checks are part of this phase): iPhone scanner incl. «Чья карточка?» and photos, the Sheet's edit
  trigger, the board, the view-only link, the test page and a full card print.
- Then a mock game at home with the printed cards and jury sheet: iPhone scanner, the
  Sheet, the board and card photos together.
- Write down the feedback as it comes (what failed, what was slow or confusing).
- Analyse each failure or bug, fix it, with a test that would have caught it.
- Finish with a thorough check of the docs, comments, memory and HANDOVER.

## Phase 8 — External test at a tournament with teams
- A real tournament: registered teams, printed decks, jury phones, the projector board.
- The same loop as Phase 7: tests on the day, feedback entry, failure and bug analysis,
  fixes, then a thorough check of the docs, comments, etc.

## Phase 9 — Next version
The one list of deferred work (HANDOVER points here): logos from image-generation
services (OpenAI, Google, …; user decision), closing the known gaps in the SVG checks first, since such
files come from outside (chgk/svg.py) · rating.chgk.info export · multi-juror UI ·
cache for board/phone reads (backend speed proposal #2).
