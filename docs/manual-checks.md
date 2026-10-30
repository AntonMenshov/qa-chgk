# Manual checks

What the automated tests can't cover (SPEC §11). Run the relevant parts after a release
that touches them, and before a real game. Use a throwaway tournament for anything
that records marks, and delete its Drive folder afterwards (`docs/google-account.md` §5).

## Backend (after every deployment)

- [ ] `uv run chgk backend check` is clean: the expected version, no missing permission,
      no "Google Sheets API service is off" warning.
- [ ] For tournaments created before the change: `uv run chgk view <folder>` (and
      `uv run chgk board <folder>` if it has no board link yet).

## The Sheet's edit trigger (needs a person typing in Google Sheets)

- [ ] On «Итоги» (or a round tab), type a name over «R1 · впишите название»: every tab
      shows the new name, and so does the hidden Teams tab.
- [ ] On «Тур 1», type `+` into an empty mark cell: it becomes `1`, the row moves to its
      sorted place, «Итоги» follows, and the hidden Log gets a `sheet` row.
- [ ] Mark a card «?» from the phone, then type `1` over it in the Sheet: it leaves the
      hidden «Спорные» tab, and the counts there go down.

## iPhone scanner

- [ ] Scan the jury access QR (page 1 of the jury sheet) with the iPhone camera: the app
      opens on the tournament, and the address bar shows no token.
- [ ] Numbered cards: team name in large type, verdict buttons; the current question
      follows the cards; a card of an earlier question warns.
- [ ] A spare card asks for the question (keypad); a reserve deck card (R1) puts the
      team on the tabs.
- [ ] Airplane mode for a few scans, then back online: the marks arrive by themselves.
- [ ] «Чья карточка?» shows team, question and mark without recording anything.
- [ ] Photos: after a few cards, the pill's «фото N» counts down to nothing; the
      tournament's `Photos` folder in Drive has one readable photo per card; a «?» card's
      photo link is on «Спорные».
- [ ] Scanning speed: a card on the table is read within about a second.

## Projector board

- [ ] Open the board QR (page 2) on the projector laptop: the title screen, then → shows
      round 1; ← takes it back; F is full screen; G switches grid/compact.

## View-only link

- [ ] Open the view-only QR (page 2) in a private window, signed out of Google: only
      «Итоги», the round tabs and «Статистика» are visible, and nothing can be edited.

## Printing

- [ ] `uv run chgk test-page <folder>`, printed at 100%: the 1″ ruler measures 1″, the QR
      codes at every size scan, the chosen logo shade stays pale.
- [ ] A full card set on the real printer: cut lines line up, cards come apart in order
      in the chosen mode, the number box on spare cards is easy to write in.
