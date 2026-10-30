# Docs to fix later

From the second docs audit (2026-10-30); small fixes were applied then. Delete items as
they are done.

## The printed jury how-to (chgk/jury.py)
- [medium] JUROR_HOWTO: "«?» (решить позже)" clashes with the app, where «Решить позже
  (карточка получена)» is a separate link that records only `R`; «?» means disputed.
- [medium] JUROR_HOWTO: say that after adding the app to the Home Screen the access QR
  must be scanned once more inside it (iOS keeps its storage apart; SPEC §7.4).
- [medium] BOARD_HOWTO: mention the board's QR codes (Q) and G (grid/compact).
- [low] «верно»/«неверно» are lowercase, the buttons read «Верно»/«Неверно»; the list of
  hidden tabs leaves out Meta.

## SPEC.md
- [medium] §11 table: add the photo queue tests (photos.test.mjs), upload_photo backend
  tests, board tests, and a row for the two headless-Chrome tests (scanner + board).
- [medium] §8.7: the jury link format bullet belongs in §7.4; the board link format
  (`…/b/?grid=N#board=TID.TOKEN.DEPLOYMENT`, chgk/ids.py) is not documented — §10.1.
- [low] §8.6: page 3 of the jury sheet also has the «Табло» how-to.
- [low] §13: `--out`, `new --backend`; the `chgk logos` line is stale (Phase 6).
- [low] §11: "events" vectors don't exist; the link vectors aren't mentioned (also in
  tests/vectors/README.md).

## HANDOVER.md / PLAN.md
- [low] HANDOVER Sheet-tabs bullet: add «Спорные»'s photo link and layout.
- [low] HANDOVER jury printout bullet: page 3 has the «Табло» how-to.
- [low] Three overlapping "later" lists (HANDOVER Deferred, HANDOVER Next steps, PLAN
  Later): keep one (PLAN) and point to it.
- [low] PLAN Phase 5: mention the board's QR codes.

## Other docs
- [low] docs/spikes.md: "still to confirm…" (spike 1 conclusions) is answered a few lines
  later.
- [low] docs/manual-checks.md: a check for «Спорные»'s layout and for a spare card's photo.

## Code comments (not docs)
- [low] apps_script/logic.js `disputedSheet` JSDoc says "summary to F1"; it's G1 now.
