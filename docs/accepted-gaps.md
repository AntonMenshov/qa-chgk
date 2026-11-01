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
| A card opened by a link (not by the camera): if the camera is running, its photo shows the current frame; with a sheet open, or before setup, the link is dropped | Jurors scan in the app; a link is a rare way in |
| A card of a team not yet on the phone: the list refreshes, but the card must leave the frame and return to count | The juror sees «обновляю список команд» and rescans |
| A photo the backend refuses for good is dropped, shown only as a count, and doesn't affect the pill | The answer is on paper; marks have their own state |
| A photo can be lost on a crash or a dead IndexedDB connection before it is stored | The user accepted the loss: the card itself is kept |
| A retried upload can leave an extra photo file in Drive | Harmless: the Log has one entry per `photo_id` |
| A photo's Drive link opens only for its owner | The owner shares the folder when needed |
| Two tabs of the scanner overwrite each other's unsent marks | They get a warning; a merge isn't worth its code |
| The jury token is readable by any page on the same origin | The owner publishes those pages too; a leaked link can be replaced (`chgk replace-token`) |
| Unreadable stored marks are treated as empty and overwritten by the next scan | No sign of it ever happening on an iPhone; the paper cards are the backup |
| «Отключить турнир» with storage full can lose marks held only in memory | Needs full storage and a disconnect mid-game; the paper cards are the backup |
| Storage full or blocked: cached copies deleted even when that can't help; failed small saves unreported (a second photo, a new device ID, the current question reverts) | Needs about 5 MB of text; the marks have their own warning |
| After «Отключить турнир» a rescanned card gets another photo | Harmless, and disconnecting is rare |
| In «Чья карточка?», camera trouble points at a button behind the sheet, and its title can stay out of date | Closing the sheet shows the button; nothing is recorded wrongly |
| The lookup sheet can cover half the aiming frame on small iPhones; settings of the wrong shape (only hand-edited) show a load error; the browser bar's colour differs a little | The camera reads the whole picture; the rest is cosmetic or doesn't happen in use |
| A board file that fails to load leaves a blank «Загрузка…»; a slow QR library delays the board | The operator is at a laptop with a reload button |
| The board's QR button can be pressed before data arrives; a code that can't be made is retried on each redraw | A harmless moment; it needs a broken library or an impossibly long link |
| `chgk teams` overwrites a row typed into the Sheet in the seconds between its read and its write | The organiser runs it and is the one editing; a missing row is visible afterwards |
| SVG: text like url(x) in a label and data:image/jpg images are refused; a non-square file on a coloured background or drawn in white is cut from the middle; a huge file is read before the size limit | Rare, they warn, and the file can be fixed by hand |
| The logo warning says «using the next fallback» when none follows | Not a real issue: fix the config |
| A one-question tournament shows the same sample card twice on the test page | Can't happen (user) |
| Logo drawing: no `--draw` summary or failure exit code, Ctrl-C waits for running logos, `--accept` can stop halfway, a draft doesn't notice a renamed team, no cost prompt, near-miss APPROVED replies, unquoted paths in the brief, prompt caching and budgets | The user's own tool, worked around by hand |

## Minor findings of the first pass, closed as a group
Judged not worth fixing, for these reasons:
- **Unreachable today:** bad data that validation or the phone never sends (non-scalar juror, bad base64, identical tokens, impossible dates, hand-built IDs).
- **Hand damage to the Sheet:** a renamed or deleted tab, a duplicated team ID, a stray «Тур N» tab, a broken Settings tab: they end in an error or a repair on the next pass.
- **A few phones, one tournament a day:** no retry jitter, one script-wide lock, a photo's slot idle for a second, phones whose shown marks lag until the next refresh; the server's merge rule decides.
- **Known SVG check gaps:** in PLAN Phase 9.
- **Small wording:** plural forms, status lines, error texts that name a less likely cause.

Cleanups left on purpose, because the change costs more than it saves: saving the queue on each mark (that is what makes a mark safe); the service worker re-caching each file on a reload (how updates arrive); a photo re-encoded per retry (keeping it would hold memory); the board's own `$` (importing the scanner's would load its state); Meta read with every board poll (one batched read either way); a paste over names and marks reading twice, and reserve activation re-reading Teams (both rare); `formatSheets_` on every `chgk teams` (it keeps new rows formatted); the footer rebuilt per card; the decoders in `chgk/ids.py` used only by tests (they hold the JS mirror to the vectors).

## Not reviewed yet
The user schedules a review of the changes after commit `53b045a`.
