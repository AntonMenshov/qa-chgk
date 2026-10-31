# qa-chgk: notes for Claude

Read [HANDOVER.md](HANDOVER.md) first: current state, working conventions, key decisions
(with links into [SPEC.md](SPEC.md)), next steps, lessons learned, and what a new machine
needs. SPEC.md is the design, [PLAN.md](PLAN.md) the phases.

Rules that override your defaults (details in HANDOVER «Working conventions» and «Lessons learned»):

- **No Claude attribution** in commits or PRs: no `Co-Authored-By: Claude` trailer, no
  "Generated with Claude Code" line. Commits are authored only as the user.
- Commit on `main` and push. Tests (`uv run pytest`, `npm test`) and lint/format pass first,
  and HANDOVER is updated in the same commit.
- Ask the user through the question interface (AskUserQuestion), a few questions at a time,
  with a recommended option.
- A change under `apps_script/` needs a redeploy by the user: run `uv run chgk backend bundle`
  and `pbcopy < out/apps_script/Code.gs` first, then give the version and the steps. After
  "deployed": `uv run chgk backend check`, a live check, HANDOVER's version line.
- After a change to how cards or the jury sheet are drawn, regenerate the current tournament's
  cards and jury sheet (now `out/osenniy-salat/`) in the mode already used, without asking.
- `logos/drafts/` holds the user's logo test drafts: never delete, overwrite or accept them.
- `ANTHROPIC_API_KEY` is set in the user's shell profile; if a command doesn't see it, run it
  through `zsh -ic '…'`. Never print or store it.
