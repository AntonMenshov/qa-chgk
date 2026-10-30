"""Jury printout (Russian): secret access QR, tournament details and links, how-to for
jurors and for «?»/appeals, team roster, and a paper backup grid."""

from collections import Counter
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
from chgk.cards.impose import Page
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
    "Перед проверкой выберите в приложении номер текущего вопроса.",
    "Сканируйте каждую карточку и нажимайте «верно», «неверно» или «?» (решить позже). "
    "Фото карточки сохраняется автоматически.",
    "Если приложение предупреждает, что карточка от другого вопроса или уже отмечена, "
    "проверьте номер на карточке.",
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

GRID_LEGEND = "+ верно,  − неверно,  ? спорно,  пусто — нет карточки."


def _styles() -> dict[str, ParagraphStyle]:
    _fonts()
    base = ParagraphStyle("base", fontName=FONT, fontSize=9.5, leading=12)
    return {
        "base": base,
        "small": ParagraphStyle("small", parent=base, fontSize=7.5, leading=9.5, wordWrap="CJK"),
        "h1": ParagraphStyle("h1", parent=base, fontName=FONT_BOLD, fontSize=17, leading=21, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=base, fontName=FONT_BOLD, fontSize=12.5, leading=16, spaceBefore=8, spaceAfter=4),
        "h3": ParagraphStyle("h3", parent=base, fontName=FONT_BOLD, fontSize=10.5, leading=13, spaceBefore=6, spaceAfter=3),
        "secret": ParagraphStyle("secret", parent=base, fontName=FONT_BOLD, fontSize=12, leading=15),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=10),
    }


class QR(Flowable):
    def __init__(self, payload: str, size: float):
        super().__init__()
        self.payload, self.size = payload, size

    def wrap(self, *_):
        return self.size, self.size

    def draw(self):
        draw_qr(self.canv, self.payload, Rect(0, 0, self.size, self.size))


class CheckBox(Flowable):
    def __init__(self, size: float = 9):
        super().__init__()
        self.size = size

    def wrap(self, *_):
        return self.size, self.size

    def draw(self):
        self.canv.setLineWidth(0.6)
        self.canv.rect(0, 0, self.size, self.size)


def card_counts(tournament: Tournament, teams: list[Team], pages: list[Page] | None) -> dict[str, tuple[int, int]]:
    """team_id → (numbered cards, spare cards), as actually printed when `pages` is given."""
    if pages is None:
        return {t.team_id: (tournament.total_questions, tournament.spares_per_team) for t in teams}
    numbered, spares = Counter(), Counter()
    for page in pages:
        for card in page:
            if card is not None:
                (spares if card.is_spare else numbered)[card.team.team_id] += 1
    return {t.team_id: (numbered[t.team_id], spares[t.team_id]) for t in teams}


def _questions_line(t: Tournament) -> str:
    sizes = t.round_sizes
    if len(set(sizes)) == 1:
        return f"{t.rounds} × {sizes[0]} = {t.total_questions} вопросов"
    return f"{' + '.join(map(str, sizes))} = {t.total_questions} вопросов"


def _access_block(t: Tournament, state: State, s) -> Table:
    access = state.jury_access
    if access:
        link = encode_jury_link(t.scanner_url, access)
        left = QR(link, 1.9 * INCH)
        right = [
            Paragraph("Доступ жюри — секретно", s["secret"]),
            Spacer(1, 4),
            Paragraph("Отсканируйте камерой iPhone один раз на каждом телефоне жюри. "
                      "Не оставляйте этот лист на виду у команд.", s["base"]),
            Spacer(1, 6),
            Paragraph(escape(link), s["small"]),
        ]
    else:
        left = Paragraph("нет доступа", s["base"])
        right = [
            Paragraph("Доступ жюри ещё не создан", s["secret"]),
            Spacer(1, 4),
            Paragraph("Выполните «uv run chgk new &lt;папка турнира&gt;» и распечатайте этот лист заново: "
                      "здесь появится секретный QR-код для телефонов жюри.", s["base"]),
        ]
    table = Table([[left, right]], colWidths=[2.1 * INCH, WIDTH - 2.1 * INCH])
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 1.2, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def _links_table(t: Tournament, state: State, s) -> Table:
    backend = NOT_YET
    if state.backend_url:
        label = " · ".join(x for x in (state.backend_profile, state.backend_account) if x)
        backend = f"{escape(label)}<br/>{escape(state.backend_url)}" if label else escape(state.backend_url)
    rows = [
        ("Сканер жюри", t.scanner_url),
        ("Таблица результатов", state.spreadsheet_url),
        ("Табло для проектора", state.board_url),
    ]
    data = [
        [Paragraph(name, s["cell"]), Paragraph(escape(url) if url else NOT_YET, s["small"]),
         QR(url, 0.75 * INCH) if url else ""]
        for name, url in rows
    ]
    data.append([Paragraph("Бэкенд (Google-аккаунт)", s["cell"]), Paragraph(backend, s["small"]), ""])
    table = Table(data, colWidths=[1.6 * INCH, WIDTH - 2.6 * INCH, 1.0 * INCH])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (2, 0), (2, -1), "CENTER"),
    ]))
    return table


def _numbered(items: list[str], s) -> list[Flowable]:
    return [Paragraph(f"{i}. {text}", s["base"]) for i, text in enumerate(items, start=1)]


def _team_label(team: Team, width: float, warnings: list[str]) -> str:
    text, _ = fit_text(f"{team.team_id}  {printable(team.name, warnings)}", FONT, 8.5, width - 8, 8.5)
    return text


def _roster(teams: list[Team], counts, s, warnings: list[str]) -> Table:
    header = ["ID", "Команда", "Город", "Карточек", "Запасных", "Выдано"]
    rows = [[Paragraph(h, s["cell"]) for h in header]]
    for team in teams:
        numbered, spares = counts[team.team_id]
        rows.append([
            team.team_id,
            Paragraph(escape(printable(team.name, warnings)), s["cell"]),
            Paragraph(escape(printable(team.city, warnings)), s["cell"]),
            str(numbered), str(spares), CheckBox(),
        ])
    widths = [0.5 * INCH, WIDTH - 4.1 * INCH, 1.4 * INCH, 0.8 * INCH, 0.8 * INCH, 0.6 * INCH]
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONT", (0, 0), (-1, -1), FONT, 8.5),
        ("FONT", (0, 0), (-1, 0), FONT_BOLD, 8.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.Color(0.92, 0.92, 0.92)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (3, 1), (-1, -1), "CENTER"),
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


def render_jury_sheet(
    tournament: Tournament,
    state: State,
    teams: list[Team],
    out_path: Path,
    pages: list[Page] | None = None,
) -> list[str]:
    """Write the jury PDF; return warnings (characters the font cannot print)."""
    s = _styles()
    warnings: list[str] = []
    name = escape(printable(tournament.name, warnings))
    story: list[Flowable] = [
        Paragraph(f"{name} — жюри", s["h1"]),
        Paragraph(
            f"{tournament.date.strftime('%d.%m.%Y')} · {_questions_line(tournament)} · "
            f"команд: {len(teams)} · ID турнира: <b>{state.tid}</b>",
            s["base"],
        ),
        Spacer(1, 10),
        _access_block(tournament, state, s),
        Spacer(1, 10),
        _links_table(tournament, state, s),
        Paragraph("Как работать жюри", s["h2"]),
        *_numbered(JUROR_HOWTO, s),
        Paragraph("Спорные ответы («?») и апелляции", s["h2"]),
        *_numbered(APPEALS_HOWTO, s),
        PageBreak(),
        Paragraph("Команды", s["h2"]),
        _roster(teams, card_counts(tournament, teams, pages), s, warnings),
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

    def footer(canvas, doc):
        canvas.setFont(FONT, 7.5)
        canvas.setFillGray(0.4)
        canvas.drawString(MARGIN, 0.3 * INCH, f"{printable(tournament.name, [])} · лист жюри · секретно")
        canvas.drawRightString(PAGE_W - MARGIN, 0.3 * INCH, f"стр. {doc.page}")

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out_path), pagesize=(PAGE_W, PAGE_H), leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=0.6 * INCH, title=f"{tournament.name} — жюри",
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return sorted(set(warnings))
