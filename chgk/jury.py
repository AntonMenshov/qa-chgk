"""Jury printout (Russian).

Page 1: every QR code (jury access, scanner, Sheet, board), spread over the page so the
wrong one is hard to scan by accident. Page 2: details, links, how-to. Then one form per
team (ID, name, players), blank forms for reserve teams, and the paper backup grid."""

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
from chgk.cards.render import FONT, FONT_BOLD, _fonts, draw_qr, fit_text, printable
from chgk.config import Tournament
from chgk.ids import encode_jury_link
from chgk.state import State
from chgk.teams import Team

MARGIN = 0.5 * INCH
WIDTH = PAGE_W - 2 * MARGIN
NOT_YET = "— ещё не настроено"

JUROR_HOWTO = [
    "Один раз на каждом телефоне жюри: отсканируйте камерой iPhone QR-код доступа "
    "на этом листе, откройте ссылку и добавьте приложение на экран «Домой».",
    "Сканируйте каждую карточку и нажимайте «верно», «неверно» или «?» (решить позже). "
    "Номер вопроса берётся из QR-кода карточки; выбирать его не нужно. "
    "Фото карточки сохраняется автоматически.",
    "Текущий вопрос (крупно вверху) приложение определяет само по отсканированным карточкам.",
    "Если приложение предупреждает, что карточка от прошлого вопроса или уже отмечена, "
    "проверьте номер на карточке: отметка всё равно идёт в вопрос, указанный на ней.",
    "Запасная карточка: приложение предложит текущий вопрос. Подтвердите его или "
    "выберите номер, который команда вписала в пустую рамку.",
    "«Нет карточек: N» — команды, чьи карточки по этому вопросу ещё не отсканированы.",
    "Пропал интернет — продолжайте работать: отметки и фото отправятся сами, когда "
    "связь вернётся (счётчик «не отправлено»).",
    "Телефон не работает — отмечайте на бумажной сетке в конце этого листа "
    "и перенесите отметки в таблицу позже.",
]

APPEALS_HOWTO = [
    "Откройте таблицу результатов, лист нужного тура («Тур 1», «Тур 2», …); общий зачёт — "
    "на листе «Итоги». В клетке команды и вопроса: "
    "пусто — карточки нет; R — карточка получена, но не проверена; 1 — верно; "
    "0 — неверно; ? — спорно.",
    "Чтобы решить «?» или апелляцию, впишите в клетку 1 или 0. Изменение попадёт в "
    "журнал (лист «Log»); всегда действует последнее изменение.",
    "Лист «Log» вручную не правьте: это журнал всех отметок.",
]

RESERVE_HOWTO = [
    "Пришла незарегистрированная команда: выдайте ей запасной комплект карточек (R1, R2, …; "
    "без названия, с общим логотипом) и бланк состава с тем же ID.",
    "Карточки этой команды сканируйте как обычно. После первого скана в таблице появится "
    "строка «R1 · впишите название».",
    "Впишите название команды вместо этого текста — на листе «Итоги», на любом листе тура "
    "или на листе «Teams». Название появится на всех листах.",
]

GRID_LEGEND = "+ верно,  − неверно,  ? спорно,  пусто — нет карточки."
PLAYER_LINES = 8
FORMS_NOTE = "Раздайте бланки командам и соберите заполненные."
FORMS_RESERVE_NOTE = ("Бланки с ID R1, R2, … — для команд, пришедших без регистрации: название команды "
                      "впишите в таблицу (см. стр. 2).")


def _styles() -> dict[str, ParagraphStyle]:
    _fonts()
    base = ParagraphStyle("base", fontName=FONT, fontSize=9.5, leading=12)
    return {
        "base": base,
        "small": ParagraphStyle("small", parent=base, fontSize=7.5, leading=9.5, wordWrap="CJK"),
        "url": ParagraphStyle("url", parent=base, fontSize=6.5, leading=8, wordWrap="CJK", alignment=1),
        "hint": ParagraphStyle("hint", parent=base, fontSize=9, leading=11, alignment=1),
        "panel": ParagraphStyle("panel", parent=base, fontName=FONT_BOLD, fontSize=15, leading=18, alignment=1),
        "h1": ParagraphStyle("h1", parent=base, fontName=FONT_BOLD, fontSize=17, leading=21, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=base, fontName=FONT_BOLD, fontSize=12.5, leading=16, spaceBefore=8, spaceAfter=4),
        "h3": ParagraphStyle("h3", parent=base, fontName=FONT_BOLD, fontSize=10.5, leading=13, spaceBefore=6, spaceAfter=3),
        "secret": ParagraphStyle("secret", parent=base, fontName=FONT_BOLD, fontSize=12, leading=15),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=10),
        "form_id": ParagraphStyle("form_id", parent=base, fontName=FONT_BOLD, fontSize=13, leading=15),
        "form_name": ParagraphStyle("form_name", parent=base, fontName=FONT_BOLD, fontSize=13, leading=15),
        "form_hint": ParagraphStyle("form_hint", parent=base, fontSize=8, leading=10, textColor=colors.grey),
    }


def _link(url: str) -> str:
    """Paragraph markup for a clickable URL. Long URLs wrap over lines; without a real
    link annotation a PDF viewer would only link the first line (a cut-off address)."""
    return f'<a href="{escape(url, {chr(34): "&quot;"})}" color="#1a4fa0">{escape(url)}</a>'


def _qr_panels(t: Tournament, state: State) -> list[tuple[str, str, str | None, bool]]:
    """(title, hint, payload or None, secret) for every QR code the jury needs."""
    access = state.jury_access
    return [
        ("Доступ жюри — секретно",
         "Один раз на каждом телефоне жюри: отсканируйте камерой iPhone." if access
         else "Ещё не создан: выполните «uv run chgk new» и распечатайте лист заново.",
         encode_jury_link(t.scanner_url, access) if access else None, True),
        ("Сканер", "Открыть приложение жюри (без доступа к турниру).", t.scanner_url, False),
        ("Таблица результатов", "Google Sheet: «Итоги», листы туров.", state.spreadsheet_url or None, False),
        ("Табло для проектора", "Открыть на компьютере у проектора.", state.board_url or None, False),
    ]


class QrGrid(Flowable):
    """All QR codes on one page, one per quarter: far apart, so the wrong one is hard to scan."""

    QR_SIZE = 1.8 * INCH

    def __init__(self, panels, styles):
        super().__init__()
        self.panels, self.s = panels, styles

    def wrap(self, avail_w, avail_h):
        self.w, self.h = avail_w, avail_h
        return avail_w, avail_h

    def _para(self, text, style, x, top, width):
        para = Paragraph(text, style)
        _, height = para.wrap(width, 1000)
        para.drawOn(self.canv, x, top - height)
        return height

    def draw(self):
        c = self.canv
        cols, rows = 2, (len(self.panels) + 1) // 2
        cw, ch = self.w / cols, self.h / rows
        c.setStrokeGray(0.75)
        c.setLineWidth(0.5)
        c.setDash(3, 3)
        for i in range(1, cols):
            c.line(i * cw, 0, i * cw, self.h)
        for j in range(1, rows):
            c.line(0, j * ch, self.w, j * ch)
        c.setDash()
        for k, (title, hint, payload, secret) in enumerate(self.panels):
            x, top = (k % cols) * cw, self.h - (k // cols) * ch
            inner = cw - 0.5 * INCH
            left = x + 0.25 * INCH
            if secret:
                c.setStrokeGray(0)
                c.setLineWidth(1.6)
                c.rect(x + 0.1 * INCH, top - ch + 0.1 * INCH, cw - 0.2 * INCH, ch - 0.2 * INCH)
            y = top - 0.3 * INCH
            y -= self._para(escape(title), self.s["panel"], left, y, inner) + 4
            y -= self._para(escape(hint), self.s["hint"], left, y, inner) + 10
            qr_x = x + (cw - self.QR_SIZE) / 2
            if payload:
                draw_qr(c, payload, Rect(qr_x, y - self.QR_SIZE, self.QR_SIZE, self.QR_SIZE))
                # The QR code itself is clickable too (full URL).
                c.linkURL(payload, (qr_x, y - self.QR_SIZE, qr_x + self.QR_SIZE, y), relative=1)
                y -= self.QR_SIZE + 8
                self._para(_link(payload), self.s["url"], left, y, inner)
            else:
                c.setStrokeGray(0.6)
                c.setLineWidth(0.8)
                c.setDash(2, 2)
                c.rect(qr_x, y - self.QR_SIZE, self.QR_SIZE, self.QR_SIZE)
                c.setDash()
                self._para(NOT_YET, self.s["hint"], qr_x, y - self.QR_SIZE / 2 + 6, self.QR_SIZE)


def _questions_line(t: Tournament) -> str:
    sizes = t.round_sizes
    if len(set(sizes)) == 1:
        return f"{t.rounds} × {sizes[0]} = {t.total_questions} вопросов"
    return f"{' + '.join(map(str, sizes))} = {t.total_questions} вопросов"


def _links_table(t: Tournament, state: State, s) -> Table:
    """The same links as text (the QR codes are all on page 1)."""
    backend = NOT_YET
    if state.backend_url:
        label = " · ".join(x for x in (state.backend_profile, state.backend_account) if x)
        backend = f"{escape(label)}<br/>{escape(state.backend_url)}" if label else escape(state.backend_url)
    rows = [
        ("Сканер жюри", _link(t.scanner_url)),
        ("Таблица результатов", _link(state.spreadsheet_url) if state.spreadsheet_url else NOT_YET),
        ("Табло для проектора", _link(state.board_url) if state.board_url else NOT_YET),
        ("Бэкенд (Google-аккаунт)", backend),
    ]
    data = [[Paragraph(name, s["cell"]), Paragraph(value, s["small"])] for name, value in rows]
    table = Table(data, colWidths=[1.6 * INCH, WIDTH - 1.6 * INCH])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return table


def _numbered(items: list[str], s) -> list[Flowable]:
    return [Paragraph(f"{i}. {text}", s["base"]) for i, text in enumerate(items, start=1)]


def _team_label(team: Team, width: float, warnings: list[str]) -> str:
    if team.reserve:
        return f"{team.team_id}  ________________"
    text, _ = fit_text(f"{team.team_id}  {printable(team.name, warnings)}", FONT, 8.5, width - 8, 8.5)
    return text


def _player_form(team: Team, s, warnings: list[str]) -> Table:
    """ID and team name, then lines for the players. A reserve team writes its name in."""
    name = (Paragraph("Название команды:", s["form_hint"]) if team.reserve
            else Paragraph(escape(printable(team.name, warnings)), s["form_name"]))
    rows = [[Paragraph(escape(team.team_id), s["form_id"]), name],
            ["№", "Фамилия и имя игрока"]]
    rows += [[str(i), ""] for i in range(1, PLAYER_LINES + 1)]
    table = Table(rows, colWidths=[0.9 * INCH, WIDTH - 0.9 * INCH],
                  rowHeights=[0.42 * INCH, 0.2 * INCH] + [0.27 * INCH] * PLAYER_LINES)
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 1.0, colors.black),
        ("LINEBELOW", (0, 0), (-1, 0), 1.0, colors.black),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, colors.grey),
        ("LINEAFTER", (0, 0), (0, -1), 0.4, colors.grey),
        ("FONT", (0, 1), (-1, -1), FONT, 9),
        ("FONT", (0, 1), (-1, 1), FONT, 7.5),
        ("TEXTCOLOR", (0, 1), (-1, 1), colors.grey),
        ("VALIGN", (0, 0), (-1, 0), "MIDDLE"),
        ("VALIGN", (0, 2), (-1, -1), "BOTTOM"),
        ("ALIGN", (0, 1), (0, -1), "CENTER"),
    ]))
    return table


def _grid(header: list[str], teams: list[Team], name_w: float, s, warnings: list[str]) -> Table:
    n = len(header)
    other_w = (WIDTH - name_w) / n
    rows = [["Команда"] + header] + [[_team_label(t, name_w, warnings)] + [""] * n for t in teams]
    table = Table(rows, colWidths=[name_w] + [other_w] * n, rowHeights=0.25 * INCH, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), FONT, 8.5),
        ("FONT", (0, 0), (-1, 0), FONT_BOLD, 8.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.92, 0.92, 0.92)),
        ("BACKGROUND", (-1, 1), (-1, -1), colors.Color(0.96, 0.96, 0.96)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
    ]))
    return table


def render_jury_sheet(tournament: Tournament, state: State, teams: list[Team], out_path: Path) -> list[str]:
    """Write the jury PDF; return warnings (characters the font cannot print).

    `teams` are the organiser's teams followed by the reserve teams.
    """
    s = _styles()
    warnings: list[str] = []
    name = escape(printable(tournament.name, warnings))
    registered = sum(1 for t in teams if not t.reserve)
    reserve = len(teams) - registered
    story: list[Flowable] = [
        Paragraph(f"{name} — QR-коды жюри", s["h1"]),
        Paragraph("Секретно: не оставляйте этот лист на виду у команд. Коды разнесены по углам, "
                  "чтобы случайно не отсканировать соседний.", s["base"]),
        Spacer(1, 8),
        QrGrid(_qr_panels(tournament, state), s),
        PageBreak(),
        Paragraph(f"{name} — жюри", s["h1"]),
        Paragraph(
            f"{tournament.date.strftime('%d.%m.%Y')} · {_questions_line(tournament)} · "
            f"команд: {registered}" + (f" + запасных комплектов: {reserve}" if reserve else "")
            + f" · ID турнира: <b>{state.tid}</b>",
            s["base"],
        ),
        Spacer(1, 8),
        _links_table(tournament, state, s),
        Paragraph("Как работать жюри", s["h2"]),
        *_numbered(JUROR_HOWTO, s),
        Paragraph("Спорные ответы («?») и апелляции", s["h2"]),
        *_numbered(APPEALS_HOWTO, s),
    ]
    if reserve:
        story += [Paragraph("Команда без регистрации", s["h2"]), *_numbered(RESERVE_HOWTO, s)]
    story += [PageBreak(), Paragraph("Команды и составы", s["h2"]), Paragraph(FORMS_NOTE + (" " + FORMS_RESERVE_NOTE if reserve else ""), s["base"]), Spacer(1, 8)]
    for team in teams:
        story.append(KeepTogether([_player_form(team, s, warnings), Spacer(1, 14)]))
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
        story.append(KeepTogether([
            Paragraph(f"Тур {round_no} (вопросы {questions[0]}–{questions[-1]})", s["h3"]),
            _grid([str(q) for q in questions] + ["Сумма"], teams, name_w, s, warnings),
        ]))
    story.append(KeepTogether([
        Paragraph("Итого", s["h3"]),
        _grid([f"Тур {r}" for r in range(1, tournament.rounds + 1)] + ["Итого"], teams, name_w, s, warnings),
    ]))

    def footer(label):
        def draw(canvas, doc):
            canvas.setFont(FONT, 7.5)
            canvas.setFillGray(0.4)
            canvas.drawString(MARGIN, 0.3 * INCH, f"{printable(tournament.name, [])} · {label}")
            canvas.drawRightString(PAGE_W - MARGIN, 0.3 * INCH, f"стр. {doc.page}")
        return draw

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path), pagesize=(PAGE_W, PAGE_H), leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=0.6 * INCH, title=f"{tournament.name} — жюри",
    )
    # Only page 1 holds the secret access QR.
    doc.build(story, onFirstPage=footer("лист жюри · секретно"), onLaterPages=footer("лист жюри"))
    return sorted(set(warnings))
