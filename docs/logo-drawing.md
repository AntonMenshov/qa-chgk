# How Claude draws logo drafts

`uv run chgk logos <folder> --draw [--team A01]`, code in `chgk/logo_drafts.py`. What the command is for, and
preview and accept: [SPEC.md §9.1](../SPEC.md). Not needed for Phases 7 and 8: no new logos are drawn there.
`ANTHROPIC_API_KEY` comes from the shell profile; a Claude Code session started before it was set doesn't see
it, so run `zsh -ic 'uv run chgk logos … --draw'`.

- **Claude-drawn drafts** (`--draw`): for registered teams whose own logo can't be used and
  that have no draft yet; `--draw --team A01` draws (or redraws) those teams whatever
  their logo. Always Claude Opus 5.5 (`claude-opus-5-5`) at **max effort** (user,
  2026-10-30), streamed, up to 128K output tokens, server-side `fallbacks: "default"` (a
  declined request is re-run on Anthropic's fallback model); 4 teams at a time. A task budget
  of 100k tokens (beta `task-budgets-2026-03-13`), which Claude sees and plans to finish within,
  so a drawing ends before 128K with an SVG (without it, half of the first drawings didn't); a
  drawing cut off anyway is asked for again once. Each round prints its time and output tokens.
- **The prompt** (`chgk/logo_drafts.py`): a system text on how the logo is used, built from
  the tournament's own cards (`logo_look`: printed size, card size, shade, whether the QR
  covers its corner), and the set's style; then
  `style_rules(name)`, written from the first 22 drafts: one idea that the owl itself acts
  out, at most three props each recognisable by its outline (no joke resting on small
  details), the owl's anatomy, layout zones in canvas units (drawing y 40–720, name below
  760, 30-unit margins, top-right corner for accents only), grey ranges (no large area darker
  than #c8c8c8), the name's exact spelling and size rule (a bold capital ≈ 0.62 × size, lines
  under 900), and the allowed SVG elements. Up to 4 library logos (the owl first, no drafts)
  go as 512 px PNG references, cached across teams.
- **Review loop** (user: "the API does the same loop" as a Claude Code session): after the
  drawing, its rendering goes back in the same conversation: full size (800 px), pale at card
  size (260 px, the tournament's shade), and measured facts (where the ink reaches, edges
  closer than 30 units), with `review_checklist(name)`. Claude replies `APPROVED` or a
  complete corrected SVG; up to `REVIEW_ROUNDS` = 2 reviews. A reply without a usable SVG
  (none, refused, undrawable) goes back as feedback; a declined or cut-off review keeps the
  drawing it had. No usable SVG in any round is reported for that team, and the others go
  on; a refused key stops the teams not started yet.
- **Without a key:** `--draw` sends nothing and writes `out/<slug>/logo-brief.md` for a Claude
  Code session: the same system text, rules and review checklist, the reference paths and
  each draft's path, and how to render a drawing to review it.
