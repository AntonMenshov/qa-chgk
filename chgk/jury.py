"""Jury printout (Russian).

Page 1 (secret, jury only): QR codes for jury access, the editable Sheet and the scanner.
Page 2: QR codes for the projector board and the view-only Sheet. Page 3: details, links,
how-to. Then one form per team (ID, name, players) in two columns, blank forms for reserve
teams, and the paper backup grid.

After `chgk replace-token` the sheet carries a version number (sheet_version) and a boxed
notice of each replacement on page 1 (and a board one on page 2 too).
"""

from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from chgk.cards.geometry import INCH, PAGE_H, PAGE_W, Rect
from chgk.cards.render import FONT, FONT_BOLD, draw_qr, fit_text, printable, register_fonts
from chgk.config import Tournament
from chgk.ids import encode_board_link, encode_jury_link
from chgk.state import State
from chgk.teams import Team

MARGIN = 0.5 * INCH
WIDTH = PAGE_W - 2 * MARGIN
NOT_YET = "— ещё не настроено"

JUROR_HOWTO = [
    "Один раз на каждом телефоне жюри: отсканируйте камерой iPhone QR-код доступа "
    "на этом листе, откройте ссылку и добавьте приложение на экран «Домой». Затем откройте "
    "приложение с экрана «Домой» и отсканируйте этот QR-код ещё раз уже в нём: у него своя память.",
    "Сканируйте каждую карточку и нажимайте «Верно», «Неверно» или «?» — спорный ответ, его "
    "решают потом в таблице. «Решить позже» — карточка только отмечена как полученная. "
    "Номер вопроса берётся из QR-кода карточки; выбирать его не нужно. "
    "Фото карточки сохраняется само (папка Photos турнира в Google Drive).",
    "Текущий вопрос (крупно вверху) приложение определяет само по отсканированным карточкам.",
    "Если приложение предупреждает, что карточка от прошлого вопроса или уже отмечена, "
    "проверьте номер на карточке: отметка всё равно идёт в вопрос, указанный на ней.",
    "Запасная карточка (в QR-коде нет номера): приложение спросит номер вопроса. Введите "
    "номер, который команда вписала в рамку, или нажмите кнопку с текущим вопросом.",
    "«Нет карточек: N» — команды, чьи карточки по этому вопросу ещё не отсканированы.",
    "«Чья карточка?» — просто прочитать карточку: приложение показывает команду, вопрос "
    "и уже стоящую отметку, ничего не записывая. «Готово» — назад к проверке.",
    "Пропал интернет — продолжайте работать: отметки и фото отправятся сами, когда связь "
    "вернётся (вверху — число неотправленных; «отправлено» — всё дошло).",
    "Телефон не работает — отмечайте на бумажной сетке в конце этого листа и перенесите отметки в таблицу позже.",
]

APPEALS_HOWTO = [
    "Откройте таблицу результатов, лист нужного тура («Тур 1», «Тур 2», …); общий зачёт — "
    "на листе «Итоги». В клетке команды и вопроса: "
    "пусто — карточки нет; R — карточка получена, но не проверена; 1 — верно; "
    "0 — неверно; ? — спорно.",
    "Все нерешённые «?» собраны на листе «Спорные»: тур, вопрос, команда, фото карточки; "
    "справа — сколько их всего, по турам и по командам. Список обновляется сам.",
    "Чтобы решить «?» или апелляцию, впишите в клетку на листе тура 1 или 0. Изменение попадёт в "
    "журнал (лист «Log»); всегда действует последнее изменение.",
    "Листы «Спорные», Teams, Log, Settings и Meta скрыты, чтобы их не было видно по ссылке «только "
    "просмотр»; открыть — кнопка «Все листы» (три полоски) внизу слева. Лист «Log» вручную не правьте: "
    "это журнал всех отметок.",
]

BOARD_HOWTO = [
    "Откройте QR «Табло для проектора» (стр. 2) на компьютере у проектора; F — во весь экран.",
    "Табло ничего не показывает, пока не нажать стрелку вправо (или пробел): каждое нажатие "
    "открывает следующий тур, стрелка влево убирает последний. Места считаются только по "
    "открытым турам.",
    "Исправления после апелляций в открытых турах появятся сами (табло обновляется каждые 15 с).",
    "На табло видны QR-коды таблицы «только просмотр» и самого табло — их можно сканировать "
    "из зала; Q — скрыть или показать их. G — вся сетка туров или только последний тур.",
]

RESERVE_HOWTO = [
    "Пришла незарегистрированная команда: выдайте ей запасной комплект карточек (R1, R2, …; "
    "без названия, с общим логотипом) и бланк состава с тем же ID.",
    "Карточки этой команды сканируйте как обычно. После первого скана в таблице появится "
    "строка «R1 · впишите название».",
    "Впишите название команды вместо этого текста — на листе «Итоги» или на любом листе тура. "
    "Название появится на всех листах.",
]

PUBLIC_NOTE = (
    "Без секретов. Таблицу «только просмотр» можно показать командам: отметки видны в ней сразу, "
    "как их ставит жюри, а табло показывает тур только после нажатия стрелки."
)
GRID_LEGEND = "+ верно,  − неверно,  ? спорно,  пусто — нет карточки."

# A token replaced after a leaked link (`chgk replace-token`): what happened and what to do.
REPLACED_NOTE = {
    "jury": "Ключ доступа жюри заменён {at}: прежние QR-код и ссылка «Доступ жюри» больше не действуют. "
    "Каждый телефон жюри один раз сканирует новый QR «Доступ жюри» на этой странице; "
    "неотправленные отметки и фото уйдут с новым ключом.",
    "board": "Ссылка табло заменена {at}: прежняя больше не действует. "
    "Откройте табло на проекторе по новому QR на стр. 2.",
}
PLAYER_LINES = 8
FORMS_NOTE = "Раздайте бланки командам и соберите заполненные."
FORMS_RESERVE_NOTE = (
    "Бланки с ID R1, R2, … — для команд, пришедших без регистрации: название команды впишите в таблицу (см. стр. 3)."
)


def _styles() -> dict[str, ParagraphStyle]:
    register_fonts()
    base = ParagraphStyle("base", fontName=FONT, fontSize=9.5, leading=12)
    return {
        "base": base,
        "small": ParagraphStyle("small", parent=base, fontSize=7.5, leading=9.5, wordWrap="CJK"),
        "url": ParagraphStyle("url", parent=base, fontSize=6.5, leading=8, wordWrap="CJK", alignment=1),
        "hint": ParagraphStyle("hint", parent=base, fontSize=9, leading=11, alignment=1),
        "panel": ParagraphStyle("panel", parent=base, fontName=FONT_BOLD, fontSize=15, leading=18, alignment=1),
        "h1": ParagraphStyle("h1", parent=base, fontName=FONT_BOLD, fontSize=17, leading=21, spaceAfter=4),
        "h2": ParagraphStyle(
            "h2", parent=base, fontName=FONT_BOLD, fontSize=12.5, leading=16, spaceBefore=8, spaceAfter=4
        ),
        "h3": ParagraphStyle(
            "h3", parent=base, fontName=FONT_BOLD, fontSize=10.5, leading=13, spaceBefore=6, spaceAfter=3
        ),
        "secret": ParagraphStyle("secret", parent=base, fontName=FONT_BOLD, fontSize=12, leading=15),
        "notice": ParagraphStyle("notice", parent=base, fontName=FONT_BOLD, fontSize=10.5, leading=13.5),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=10),
        "form_id": ParagraphStyle("form_id", parent=base, fontName=FONT_BOLD, fontSize=13, leading=15),
        "form_name": ParagraphStyle("form_name", parent=base, fontName=FONT_BOLD, fontSize=13, leading=15),
        "form_hint": ParagraphStyle("form_hint", parent=base, fontSize=8, leading=10, textColor=colors.grey),
    }


def _link(url: str) -> str:
    """Paragraph markup for a clickable URL.

    Long URLs wrap over lines; without a real link annotation a PDF viewer would only link
    the first line (a cut-off address).
    """
    return f'<a href="{escape(url, {chr(34): "&quot;"})}" color="#1a4fa0">{escape(url)}</a>'


def board_link(t: Tournament, state: State) -> str | None:
    access = state.board_access
    return encode_board_link(t.scanner_url, access, t.board_grid_max_teams) if access else None


Panel = tuple[str, str, str | None, bool]  # title, hint, payload or None, secret


def _jury_panels(t: Tournament, state: State) -> list[Panel]:
    """Page 1, jury only: access (secret), the Sheet with edit rights, the scanner."""
    access = state.jury_access
    return [
        (
            "Доступ жюри — секретно",
            "Один раз на каждом телефоне жюри: отсканируйте камерой iPhone."
            if access
            else "Ещё не создан: выполните «uv run chgk new» и распечатайте лист заново.",
            encode_jury_link(t.scanner_url, access) if access else None,
            True,
        ),
        (
            "Таблица — редактирование",
            "Google Sheet под аккаунтом турнира: апелляции, названия команд.",
            state.spreadsheet_url or None,
            False,
        ),
        ("Сканер", "Открыть приложение жюри (без доступа к турниру).", t.scanner_url, False),
    ]


def _jury_rows(t: Tournament, state: State) -> list[list[Panel]]:
    """Page 1: the secret access QR alone across the top half, the other two below it."""
    access, sheet, scanner = _jury_panels(t, state)
    return [[access], [sheet, scanner]]


def _public_panels(t: Tournament, state: State) -> list[Panel]:
    """Page 2: the projector board and the Sheet, view-only."""
    return [
        ("Табло для проектора", "На компьютере у проектора. После тура: стрелка вправо.", board_link(t, state), False),
        (
            "Таблица — только просмотр",
            "Можно показать командам: «Итоги» и листы туров без права правки.",
            state.view_url,
            False,
        ),
    ]


class QrPage(Flowable):
    """QR codes filling the rest of the page.

    `rows` of panels, each panel with its title, hint, the QR code as large as its box
    allows and the address under it.
    """

    GAP = 0.15 * INCH
    PAD = 0.25 * INCH
    MAX_QR = 4.0 * INCH

    def __init__(self, rows: list[list[Panel]], styles):
        super().__init__()
        self.rows, self.s = rows, styles

    def wrap(self, avail_w, avail_h):
        self.w, self.h = avail_w, avail_h
        return avail_w, avail_h

    def _height(self, text, style, width):
        return Paragraph(text, style).wrap(width, 10000)[1]

    def _para(self, text, style, x, top, width):
        para = Paragraph(text, style)
        _, height = para.wrap(width, 10000)
        para.drawOn(self.canv, x, top - height)
        return height

    def _texts(self, panel, inner):
        """Heights of the text above the QR code and of the address under it."""
        title, hint, payload, _ = panel
        above = (
            self._height(escape(title), self.s["panel"], inner) + 4 + self._height(escape(hint), self.s["hint"], inner)
        )
        below = self._height(_link(payload), self.s["url"], inner) if payload else 0
        return above, below

    def boxes(self):
        """(panel, x, y, w, h, qr_size, text_above) for every panel; one QR size per row."""
        out = []
        row_h = (self.h - self.GAP * (len(self.rows) - 1)) / len(self.rows)
        for r, row in enumerate(self.rows):
            y = self.h - (r + 1) * row_h - r * self.GAP
            w = (self.w - self.GAP * (len(row) - 1)) / len(row)
            inner = w - 2 * self.PAD
            texts = [self._texts(p, inner) for p in row]
            above = max(a for a, _ in texts)
            below = max(b for _, b in texts)
            size = min(inner, row_h - 2 * self.PAD - above - below - 0.35 * INCH, self.MAX_QR)
            for k, panel in enumerate(row):
                out.append((panel, k * (w + self.GAP), y, w, row_h, size, above))
        return out

    def draw(self):
        c = self.canv
        for (title, hint, payload, secret), x, y, w, h, size, above in self.boxes():
            inner = w - 2 * self.PAD
            left = x + self.PAD
            c.setStrokeGray(0 if secret else 0.7)
            c.setLineWidth(1.8 if secret else 0.6)
            c.rect(x, y, w, h)
            top = y + h - self.PAD
            top -= self._para(escape(title), self.s["panel"], left, top, inner) + 4
            self._para(escape(hint), self.s["hint"], left, top, inner)
            # The QR code (and the address under it) centred in the space under the text.
            space_top = y + h - self.PAD - above
            url_h = self._height(_link(payload), self.s["url"], inner) if payload else 0
            block = size + (8 + url_h if payload else 0)
            qr_top = space_top - (space_top - (y + self.PAD) - block) / 2
            qr_x = x + (w - size) / 2
            if payload:
                draw_qr(c, payload, Rect(qr_x, qr_top - size, size, size))
                # The QR code itself is clickable too (full URL).
                c.linkURL(payload, (qr_x, qr_top - size, qr_x + size, qr_top), relative=1)
                self._para(_link(payload), self.s["url"], left, qr_top - size - 8, inner)
            else:
                c.setStrokeGray(0.6)
                c.setLineWidth(0.8)
                c.setDash(2, 2)
                c.rect(qr_x, qr_top - size, size, size)
                c.setDash()
                self._para(NOT_YET, self.s["hint"], qr_x, qr_top - size / 2 + 6, size)


def sheet_version(state: State) -> int:
    """1 for the first jury sheet; one more for each token replaced since."""
    return 1 + len(state.replaced)


def _replaced_notes(state: State, kinds: tuple[str, ...], s) -> list[Flowable]:
    """A boxed notice for each replaced token of these kinds, oldest first."""
    notes = []
    for r in state.replaced:
        if r["which"] in kinds:
            at = datetime.fromisoformat(r["at"]).strftime("%d.%m.%Y в %H:%M")
            box = Table([[Paragraph(escape(REPLACED_NOTE[r["which"]].format(at=at)), s["notice"])]], colWidths=["100%"])
            box.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 1.5, colors.black), ("PADDING", (0, 0), (-1, -1), 6)]))
            notes += [Spacer(1, 6), box]
    return notes


def _questions_line(t: Tournament) -> str:
    sizes = t.round_sizes
    if len(set(sizes)) == 1:
        return f"{t.rounds} × {sizes[0]} = {t.total_questions} вопросов"
    return f"{' + '.join(map(str, sizes))} = {t.total_questions} вопросов"


def _links_table(t: Tournament, state: State, s) -> Table:
    """The same links as text (the QR codes are on pages 1-2)."""
    backend = NOT_YET
    if state.backend_url:
        label = " · ".join(x for x in (state.backend_profile, state.backend_account) if x)
        backend = f"{escape(label)}<br/>{_link(state.backend_url)}" if label else _link(state.backend_url)
    rows = [
        ("Сканер жюри", _link(t.scanner_url)),
        ("Таблица (редактирование)", _link(state.spreadsheet_url) if state.spreadsheet_url else NOT_YET),
        ("Таблица (только просмотр)", _link(state.view_url) if state.view_url else NOT_YET),
        ("Табло для проектора", _link(board_link(t, state)) if state.board_access else NOT_YET),
        ("Бэкенд (Google-аккаунт)", backend),
    ]
    data = [[Paragraph(name, s["cell"]), Paragraph(value, s["small"])] for name, value in rows]
    table = Table(data, colWidths=[1.6 * INCH, WIDTH - 1.6 * INCH])
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return table


def _numbered(items: list[str], s) -> list[Flowable]:
    return [Paragraph(f"{i}. {text}", s["base"]) for i, text in enumerate(items, start=1)]


def _team_label(team: Team, width: float, warnings: list[str]) -> str:
    if team.reserve:
        return f"{team.team_id}  ________________"
    text, _ = fit_text(f"{team.team_id}  {printable(team.name, warnings)}", FONT, 8.5, width - 8, 8.5)
    return text


FORM_GAP = 0.3 * INCH
FORM_W = (WIDTH - FORM_GAP) / 2
FORM_ID_W = 0.85 * INCH


def _player_form(team: Team, s, warnings: list[str]) -> Table:
    """ID and team name, then lines for the players. A reserve team writes its name in."""
    name = (
        Paragraph("Название команды:", s["form_hint"])
        if team.reserve
        else Paragraph(escape(printable(team.name, warnings)), s["form_name"])
    )
    # IDs are 1-8 characters (rating numbers such as 58746): smaller type for long ones, never wrapped.
    id_style = (
        s["form_id"] if len(team.team_id) <= 5 else ParagraphStyle("form_id_long", parent=s["form_id"], fontSize=9.5)
    )
    rows = [[Paragraph(escape(team.team_id), id_style), name], ["№", "Фамилия и имя игрока"]]
    rows += [[str(i), ""] for i in range(1, PLAYER_LINES + 1)]
    # The name row grows for a long name (wrapped); the player lines are fixed.
    table = Table(
        rows, colWidths=[FORM_ID_W, FORM_W - FORM_ID_W], rowHeights=[None, 0.2 * INCH] + [0.26 * INCH] * PLAYER_LINES
    )
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 1.0, colors.black),
                ("LINEBELOW", (0, 0), (-1, 0), 1.0, colors.black),
                ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.grey),
                ("LINEAFTER", (0, 0), (0, -1), 0.4, colors.grey),
                ("FONT", (0, 1), (-1, -1), FONT, 9),
                ("FONT", (0, 1), (-1, 1), FONT, 7.5),
                ("TEXTCOLOR", (0, 1), (-1, 1), colors.grey),
                ("VALIGN", (0, 0), (-1, 0), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, 0), 6),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
                ("VALIGN", (0, 2), (-1, -1), "BOTTOM"),
                ("ALIGN", (0, 1), (0, -1), "CENTER"),
            ]
        )
    )
    return table


def _player_forms(teams: list[Team], s, warnings: list[str]) -> list[Flowable]:
    """The forms two per row; a row never splits over pages."""
    forms = [_player_form(t, s, warnings) for t in teams]
    rows = []
    for i in range(0, len(forms), 2):
        pair = forms[i : i + 2] + [""] * (2 - len(forms[i : i + 2]))
        row = Table([[pair[0], "", pair[1]]], colWidths=[FORM_W, FORM_GAP, FORM_W])
        row.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
                ]
            )
        )
        rows.append(row)
    return rows


def _grid(header: list[str], teams: list[Team], name_w: float, s, warnings: list[str]) -> Table:
    n = len(header)
    other_w = (WIDTH - name_w) / n
    rows = [["Команда", *header]] + [[_team_label(t, name_w, warnings)] + [""] * n for t in teams]
    table = Table(rows, colWidths=[name_w] + [other_w] * n, rowHeights=0.25 * INCH, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), FONT, 8.5),
                ("FONT", (0, 0), (-1, 0), FONT_BOLD, 8.5),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.92, 0.92, 0.92)),
                ("BACKGROUND", (-1, 1), (-1, -1), colors.Color(0.96, 0.96, 0.96)),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (1, 0), (-1, -1), "CENTER"),
            ]
        )
    )
    return table


def render_jury_sheet(tournament: Tournament, state: State, teams: list[Team], out_path: Path) -> list[str]:
    """Write the jury PDF; return warnings (characters the font cannot print).

    `teams` are the organiser's teams followed by the reserve teams.
    """
    s = _styles()
    warnings: list[str] = []
    name = escape(printable(tournament.name, warnings))
    day = tournament.date.strftime("%d.%m.%Y")
    registered = sum(1 for t in teams if not t.reserve)
    reserve = len(teams) - registered
    version = sheet_version(state)
    edition = f" (версия {version})" if version > 1 else ""
    story: list[Flowable] = [
        Paragraph(f"{name}, {day} — QR-коды жюри{edition}", s["h1"]),
        Paragraph("Секретно: только для жюри, не оставляйте этот лист на виду у команд.", s["base"]),
        *_replaced_notes(state, ("jury", "board"), s),
        Spacer(1, 12),
        QrPage(_jury_rows(tournament, state), s),
        PageBreak(),
        Paragraph(f"{name}, {day} — табло и результаты{edition}", s["h1"]),
        Paragraph(PUBLIC_NOTE, s["base"]),
        *_replaced_notes(state, ("board",), s),
        Spacer(1, 12),
        QrPage([[p] for p in _public_panels(tournament, state)], s),
        PageBreak(),
        Paragraph(f"{name} — жюри", s["h1"]),
        Paragraph(
            f"{day} · {_questions_line(tournament)} · "
            f"команд: {registered}"
            + (f" + запасных комплектов: {reserve}" if reserve else "")
            + f" · ID турнира: <b>{state.tid}</b>",
            s["base"],
        ),
        Spacer(1, 8),
        _links_table(tournament, state, s),
        Paragraph("Как работать жюри", s["h2"]),
        *_numbered(JUROR_HOWTO, s),
        Paragraph("Спорные ответы («?») и апелляции", s["h2"]),
        *_numbered(APPEALS_HOWTO, s),
        Paragraph("Табло", s["h2"]),
        *_numbered(BOARD_HOWTO, s),
    ]
    if reserve:
        story += [Paragraph("Команда без регистрации", s["h2"]), *_numbered(RESERVE_HOWTO, s)]
    story += [
        PageBreak(),
        Paragraph("Команды и составы", s["h2"]),
        Paragraph(FORMS_NOTE + (" " + FORMS_RESERVE_NOTE if reserve else ""), s["base"]),
        Spacer(1, 8),
    ]
    story += _player_forms(teams, s, warnings)
    story += [
        PageBreak(),
        Paragraph("Бумажная сетка (если телефоны не работают)", s["h2"]),
        Paragraph(GRID_LEGEND, s["base"]),
    ]
    first = 1
    name_w = 2.0 * INCH
    for round_no, size in enumerate(tournament.round_sizes, start=1):
        questions = list(range(first, first + size))
        first += size
        story.append(
            KeepTogether(
                [
                    Paragraph(f"Тур {round_no} (вопросы {questions[0]}–{questions[-1]})", s["h3"]),
                    _grid([str(q) for q in questions] + ["Сумма"], teams, name_w, s, warnings),
                ]
            )
        )
    story.append(
        KeepTogether(
            [
                Paragraph("Итого", s["h3"]),
                _grid([f"Тур {r}" for r in range(1, tournament.rounds + 1)] + ["Итого"], teams, name_w, s, warnings),
            ]
        )
    )

    def footer(label):
        def draw(canvas, doc):
            canvas.setFont(FONT, 7.5)
            canvas.setFillGray(0.4)
            canvas.drawString(MARGIN, 0.3 * INCH, f"{printable(tournament.name, [])} · {day} · {label}{edition}")
            canvas.drawRightString(PAGE_W - MARGIN, 0.3 * INCH, f"стр. {doc.page}")

        return draw

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=(PAGE_W, PAGE_H),
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=0.6 * INCH,
        title=f"{tournament.name} — жюри",
    )
    # Only page 1 holds the secret access QR.
    doc.build(story, onFirstPage=footer("лист жюри · секретно"), onLaterPages=footer("лист жюри"))
    return sorted(set(warnings))
