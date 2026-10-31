# Manual checks

What the automated tests can't cover (SPEC §11). It opens Phase 7 (PLAN.md); after that,
run the relevant parts after a release that touches them, and before a real game.
Use a throwaway tournament for anything that records marks, and delete its Drive folder
afterwards (`docs/google-account.md` §5).

## Backend (after every deployment)

- [ ] `uv run chgk backend check` is clean: the expected version, no missing permission,
      no "Google Sheets API service is off" warning.

## The Sheet's edit trigger (needs a person typing in Google Sheets)

- [ ] On «Итоги» (or a round tab), type a name over «R1 · впишите название»: every tab
      shows the new name, and so does the hidden Teams tab.
- [ ] On «Тур 1», type `+` into an empty mark cell: it becomes `1`, the row moves to its
      sorted place, «Итоги» follows, and the hidden Log gets a `sheet` row.
- [ ] Mark a card «?» from the phone, then type `1` over it in the Sheet: it leaves the
      hidden «Спорные» tab, and the counts there go down. While it is there: its photo
      link sits in the wide «Фото» column (cut at the edge), the counts in G–H, clear of it.
- [ ] Clearing is a decision: mark a card online so its cell is filled, scan that card again
      with the phone in airplane mode, clear the cell in the Sheet, then go back online: the
      cell stays empty.
- [ ] Delete a team's row on «Тур 2», then scan that team's round-1 and round-2 cards: the
      round-1 mark arrives; only the round-2 one is refused (nothing stays stuck in the pill).

## iPhone scanner

- [ ] Scan the jury access QR (page 1 of the jury sheet) with the iPhone camera: the app
      opens on the tournament, and the address bar shows no token.
- [ ] Numbered cards: team name in large type, verdict buttons; the current question
      follows the cards; a card of an earlier question warns.
- [ ] A spare card asks for the question (keypad); a reserve deck card (R1) puts the
      team on the tabs. The spare card's photo is filed under that question (`…_q<NNN>_S1_…`).
- [ ] Airplane mode for a few scans, then back online: the marks arrive by themselves.
- [ ] Scan a card already judged: it says «Уже отмечено», and «Отмена (останется: …)» closes
      it with the mark unchanged.
- [ ] «Чья карточка?» shows team, question and mark without recording anything.
- [ ] Photos: after a few cards, the pill's «фото N» counts down to nothing; the
      tournament's `Photos` folder in Drive has one readable photo per card; a «?» card's
      photo link is on «Спорные».
- [ ] Scanning speed: a card on the table is read within about a second.

## A leaked link (`chgk replace-token`, throwaway tournament)

- [ ] With marks and photos waiting on a phone in airplane mode, run `chgk replace-token <folder>
      jury --yes`; back online, the phone shows «ключ жюри больше не действует…» and keeps
      them; after scanning the new QR from `jury-v2.pdf` (page 1, with the notice) they arrive.
- [ ] `chgk replace-token <folder> board --yes`: the open board says its link was replaced;
      the new link from page 2 of the new sheet works.

## Projector board

- [ ] Open the board QR (page 2) on the projector laptop: the title screen, then → shows
      round 1; ← takes it back; F is full screen; G switches grid/compact.
- [ ] Open the board QR on an iPhone: the title screen has no QR codes and says to tap
      «Показать тур 1»; the buttons stay on screen; tapping shows round 1, readable.
- [ ] Wrong answers are red crosses, cards not received are small grey dots.
- [ ] From the back of the hall, a phone reads both QR codes on the projector (the table
      and the board); Q hides and shows them.

## View-only link

- [ ] Open the view-only QR (page 2) in a private window, signed out of Google: only
      «Итоги», the round tabs and «Статистика» are visible, and nothing can be edited.

## Printing

- [ ] `uv run chgk test-page <folder>`, printed at 100%: both rulers measure 2″, the QR
      codes at every size scan, the chosen logo shade stays pale.
- [ ] A full card set on the real printer: cut lines line up, cards come apart in order
      in the chosen mode, the number box on spare cards is easy to write in.

## Logos (Phase 6)

- [ ] `uv run chgk logos <folder>`: every team's row matches its logo file; an SVG logo
      prints with its lettering in PT Sans.

The three drawing checks below are not needed for Phases 7 and 8 (user): no new logos are drawn there.

- [ ] With `ANTHROPIC_API_KEY` set: `--draw --team <id>` on a throwaway tournament gives a
      draft in the style of the library's logos (owl acting out the name, the name in bold
      capitals below); the key appears nowhere in the output.
- [ ] Without the key: `--draw` writes `out/<slug>/logo-brief.md`; a Claude Code session
      following it writes drafts that `chgk logos` accepts.
- [ ] `out/<slug>/logo-preview.pdf` printed: the drafts are pale enough to write over and
      the names readable.
