import json
from datetime import date

import pypdfium2
import pytest
import zxingcpp
from pypdf import PdfReader
from typer.testing import CliRunner

from chgk.cards.build import build_cards, build_jury_sheet
from chgk.cards.impose import Mode
from chgk.cards.render import missing_glyphs
from chgk.cli import app
from chgk.config import Tournament
from chgk.ids import decode_board_link, decode_jury_link
from chgk.jury import (
    APPEALS_HOWTO,
    BOARD_HOWTO,
    FORMS_NOTE,
    FORMS_RESERVE_NOTE,
    GRID_LEGEND,
    JUROR_HOWTO,
    NOT_YET,
    RESERVE_HOWTO,
    _questions_line,
)
from chgk.state import load_or_create_state

BACKEND = "https://script.google.com/macros/s/AKfycbTEST_deployment_0000000/exec"
runner = CliRunner()


def with_backend(folder):
    state = json.loads((folder / "state.json").read_text()) if (folder / "state.json").exists() else {}
    state.setdefault("tid", load_or_create_state(folder).tid)
    state.update(
        backend_url=BACKEND,
        backend_profile="club",
        backend_account="club@gmail.com",
        spreadsheet_id="SHEET123",
        jury_token="secretTOKEN_0123456789ab",
        board_token="boardTOKEN_0123456789ab",
        view_shared=True,
    )
    (folder / "state.json").write_text(json.dumps(state))
    return state


def text_of(pdf):
    return "\n".join(page.extract_text() for page in PdfReader(pdf).pages)


def qr_texts(pdf, page=0):
    image = pypdfium2.PdfDocument(pdf)[page].render(scale=200 / 72).to_pil()
    return [r.text for r in zxingcpp.read_barcodes(image)]


def page_texts(pdf):
    return [page.extract_text() for page in PdfReader(pdf).pages]


def test_without_backend_shows_placeholder_and_no_secret(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Ещё не создан" in text
    assert NOT_YET in text
    assert qr_texts(out) == ["https://example.github.io/qa-chgk/s/"]  # only the scanner link


VIEW = "https://docs.google.com/spreadsheets/d/SHEET123/htmlview"
EDIT = "https://docs.google.com/spreadsheets/d/SHEET123/edit"
SCANNER = "https://example.github.io/qa-chgk/s/"


def test_page_one_is_for_the_jury_page_two_for_everyone(folder, tmp_path):
    """User request: page 1 = jury access, editable Sheet, scanner; page 2 = board and view-only Sheet."""
    state = with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    page1 = qr_texts(out, 0)
    setup = [q for q in page1 if "#setup=" in q]
    assert len(setup) == 1
    access = decode_jury_link(setup[0])
    assert (access.tid, access.jury_token, access.backend_url) == (state["tid"], state["jury_token"], BACKEND)
    assert set(page1) == {setup[0], EDIT, SCANNER} and len(page1) == 3
    board = (
        "https://example.github.io/qa-chgk/b/?grid=5#board="
        + state["tid"]
        + ".boardTOKEN_0123456789ab.AKfycbTEST_deployment_0000000"
    )
    assert sorted(qr_texts(out, 1)) == sorted([board, VIEW])
    assert decode_board_link(board).board_token == "boardTOKEN_0123456789ab"
    # Pages 3 on have no QR code; the jury token is on page 1 only.
    for page in range(2, len(PdfReader(out).pages)):
        assert qr_texts(out, page) == [], f"page {page + 1}"
    texts = [" ".join(t.split()) for t in page_texts(out)]
    assert "Доступ жюри — секретно" in texts[0] and "Таблица — редактирование" in texts[0]
    assert "Табло для проектора" in texts[1] and "Таблица — только просмотр" in texts[1]
    assert state["jury_token"] not in texts[1]
    assert "разнесены" not in "".join(texts)
    assert "club · club@gmail.com" in texts[2]
    assert state["tid"] in texts[2]


def test_every_page_has_the_date(folder, tmp_path):
    """User report: the jury page had no date. The QR pages say it in the title, every page in the footer."""
    with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    texts = [" ".join(t.split()) for t in page_texts(out)]
    assert "Осенний кубок, 15.11.2026 — QR-коды жюри" in texts[0]
    assert "Осенний кубок, 15.11.2026 — табло и результаты" in texts[1]
    for i, text in enumerate(texts):
        assert "Осенний кубок · 15.11.2026 · лист жюри" in text, f"page {i + 1}"


def test_view_only_qr_waits_for_sharing(folder, tmp_path):
    state = with_backend(folder)
    state["view_shared"] = False
    (folder / "state.json").write_text(json.dumps(state))
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    assert VIEW not in qr_texts(out, 1) and len(qr_texts(out, 1)) == 1
    assert NOT_YET in page_texts(out)[1]


def test_only_the_qr_page_is_marked_secret(folder, tmp_path):
    with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    texts = page_texts(out)
    assert "лист жюри · секретно" in texts[0]
    assert all("секретно" not in t for t in texts[1:])


def test_team_forms_have_id_name_and_player_lines_only(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    forms = "\n".join(t for t in page_texts(out) if "Команды и составы" in t or "Фамилия и имя игрока" in t)
    for expected in ("A01", "Синие зайцы", "A02", "A03", "Думать быстро", "Фамилия и имя игрока"):
        assert expected in forms
    # Reserve decks R1, R2 get blank forms.
    assert forms.count("Название команды:") == 2 and "R1" in forms and "R2" in forms
    assert forms.count("Фамилия и имя игрока") == 5
    # Two columns (user request): all five forms fit on one page.
    from reportlab.pdfbase.pdfmetrics import stringWidth

    from chgk.cards.render import FONT_BOLD
    from chgk.jury import FORM_ID_W

    for team_id, size in (("58746", 13), ("ABCDEFGH", 9.5)):  # the longest IDs stay on one line
        assert stringWidth(team_id, FONT_BOLD, size) <= FORM_ID_W - 12, team_id
    assert sum("Фамилия и имя игрока" in t for t in page_texts(out)) == 1
    # No town, no card counts (user request).
    text = text_of(out)
    assert "Бостон" not in text and "Город" not in text and "Карточек" not in text and "Выдано" not in text


def test_reserve_section_and_grid_rows(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Команда без регистрации" in text
    assert "+ запасных комплектов: 2" in text
    grid = text[text.index("Бумажная сетка") :]
    assert "R1" in grid and "R2" in grid


def test_no_reserve_teams_no_reserve_forms(folder, tmp_path):
    config = folder / "config.py"
    config.write_text(
        config.read_text(encoding="utf-8").replace("spares_per_team=2,", "spares_per_team=2, reserve_teams=0,"),
        encoding="utf-8",
    )
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Название команды:" not in text and "Команда без регистрации" not in text and "R1" not in text


def test_backup_grid_has_every_round_and_totals(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    for expected in ("Бумажная сетка", "Тур 1 (вопросы 1–3)", "Тур 2 (вопросы 4–6)", "Итого", "Сумма", "A03"):
        assert expected in text


def test_static_text_is_printable():
    everything = (
        "".join(JUROR_HOWTO + APPEALS_HOWTO + RESERVE_HOWTO + BOARD_HOWTO)
        + GRID_LEGEND
        + NOT_YET
        + FORMS_NOTE
        + FORMS_RESERVE_NOTE
    )
    assert missing_glyphs(everything) == set()


@pytest.mark.parametrize("sizes,expected", [(12, "3 × 12 = 36 вопросов"), ([12, 12, 15], "12 + 12 + 15 = 39 вопросов")])
def test_questions_line(sizes, expected):
    t = Tournament(
        slug="t",
        name="T",
        date=date(2026, 1, 1),
        rounds=3,
        questions_per_round=sizes,
        scanner_url="https://e.github.io/qa-chgk/s/",
    )
    assert _questions_line(t) == expected


def test_cards_build_also_writes_jury_sheet(folder, tmp_path):
    result = build_cards(folder, Mode.CUT_STACK, tmp_path / "cards.pdf")
    assert result.jury_path == tmp_path / "cards-jury.pdf"
    assert "жюри" in text_of(result.jury_path)


def test_cli_jury_sheet(folder, tmp_path):
    out = tmp_path / "j.pdf"
    result = runner.invoke(app, ["jury-sheet", str(folder), "--out", str(out)])
    assert result.exit_code == 0, result.output
    assert out.read_bytes().startswith(b"%PDF")


def link_targets(pdf, page):
    annots = PdfReader(pdf).pages[page].get("/Annots") or []
    return [a.get_object()["/A"]["/URI"] for a in annots if "/A" in a.get_object()]


def test_links_are_clickable_with_the_full_address(folder, tmp_path):
    """Long URLs wrap over lines; each must be a real link to the whole URL (user report)."""
    state = with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    setup = next(q for q in qr_texts(out) if "#setup=" in q)
    page1, page2 = link_targets(out, 0), link_targets(out, 1)
    for url in (setup, EDIT, SCANNER):
        assert page1.count(url) >= 2, url  # the QR code and the text under it
    assert set(page1) == {setup, EDIT, SCANNER}
    board = next(u for u in page2 if "#board=" in u)
    assert page2.count(board) >= 2 and page2.count(VIEW) >= 2 and set(page2) == {board, VIEW}
    assert decode_jury_link(setup).jury_token == state["jury_token"]
    assert {EDIT, SCANNER, VIEW, board, BACKEND} <= set(link_targets(out, 2))  # page 3 links table, backend too
