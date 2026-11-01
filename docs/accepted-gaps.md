# Accepted gaps

What the code reviews of 2026-10-31 found and the user decided not to fix, with the reason. A gap
here is closed: change it only if the reason stops holding.

## Rules that replace a fix
- **Never deploy during a game.** A phone on slow Wi-Fi could load a mix of old and new files and
  fail to start until a reload (`web/s/sw.js`'s time limit is per file). «Приложение не запустилось»
  offers the reload if it happens anyway.
- **Scanner in portrait, with the iPhone's Portrait Orientation Lock on** (the jury sheet says so). In
  landscape on a notched iPhone, edge buttons can sit under the notch and the screen may scroll; a
  web page can't lock rotation.

## Won't fix
| Gap | Why not |
|---|---|
| Phone storage full: evicting the current tournament's offline copy, so a reload offline waits for the network | Needs about 5 MB of text; marks stay safe |
| `chgk new` retried on another backend after a lost reply leaves a second tournament | Needs a lost reply and a profile switch; the orphan can be deleted in Drive |
| `chgk delete` on a backend reset under the same URL removes state.json, and the Sheet stays | We never reset a backend |
| The note «Непонятное значение» stays after a scan replaces that cell | Cosmetic; the mark and totals are right |
| A photo written by the slow path can miss its link on «Спорные» until the tab's next update | Rare and temporary; the photo is safe in Drive and the Log |
| A row deleted by hand reaches the public copy only with the next change | `chgk results-copy` publishes at once; `chgk teams` says so |
| Screen readers: sheets don't take focus, toggles don't expose state | A camera scanner and a projector board: not a realistic use |
| One toast slot: a newer message can replace a red one | Lasting problems have their own banner on the main screen |
| A «Чья карточка?» result is a snapshot: it stays after the card leaves, and misses a later mark | One juror in v1; reading the card again is current |
| The test page labels «(chosen)» only among its samples, and ignores a team's own shade there | Only the label is missing; the sample cards show the real result |
| Logo drawing: no `--draw` summary or failure exit code, Ctrl-C waits for running logos, `--accept` can stop halfway, a draft doesn't notice a renamed team, no cost prompt, near-miss APPROVED replies, unquoted paths in the brief, prompt caching and budgets | The user's own tool, worked around by hand |

## Not reviewed yet
The user schedules a review of the changes after commit `53b045a`.
