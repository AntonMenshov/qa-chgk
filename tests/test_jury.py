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
from chgk.ids import decode_jury_link
from chgk.jury import APPEALS_HOWTO, FORMS_NOTE, FORMS_RESERVE_NOTE, GRID_LEGEND, JUROR_HOWTO, NOT_YET, RESERVE_HOWTO, _questions_line
from chgk.state import load_or_create_state

BACKEND = "https://script.google.com/macros/s/AKfycbTEST_deployment_0000000/exec"
runner = CliRunner()


def with_backend(folder):
    state = json.loads((folder / "state.json").read_text()) if (folder / "state.json").exists() else {}
    state.setdefault("tid", load_or_create_state(folder).tid)
    state.update(backend_url=BACKEND, backend_profile="club", backend_account="club@gmail.com",
                 spreadsheet_id="SHEET123", jury_token="secretTOKEN_0123456789ab")
    (folder / "state.json").write_text(json.dumps(state))
    return state


def text_of(pdf):
    return "\n".join(page.extract_text() for page in PdfReader(pdf).pages)


def qr_texts(pdf, page=0):
    image = pypdfium2.PdfDocument(pdf)[page].render(scale=200 / 72).to_pil()
    return [r.text for r in zxingcpp.read_barcodes(image)]


def qr_positions(pdf, page=0):
    """{payload: (x, y) centre in inches} for every QR on a page."""
    scale = 200 / 72
    image = pypdfium2.PdfDocument(pdf)[page].render(scale=scale).to_pil()
    found = {}
    for r in zxingcpp.read_barcodes(image):
        p = r.position
        cx = (p.top_left.x + p.top_right.x + p.bottom_left.x + p.bottom_right.x) / 4 / scale / 72
        cy = (p.top_left.y + p.top_right.y + p.bottom_left.y + p.bottom_right.y) / 4 / scale / 72
        found[r.text] = (cx, cy)
    return found


def page_texts(pdf):
    return [page.extract_text() for page in PdfReader(pdf).pages]


def test_without_backend_shows_placeholder_and_no_secret(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Ещё не создан" in text
    assert NOT_YET in text
    assert qr_texts(out) == ["https://example.github.io/qa-chgk/s/"]  # only the scanner link


def test_all_qr_codes_on_page_one_far_apart(folder, tmp_path):
    state = with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    qrs = qr_positions(out)
    setup = [q for q in qrs if "#setup=" in q]
    assert len(setup) == 1
    access = decode_jury_link(setup[0])
    assert (access.tid, access.jury_token, access.backend_url) == (state["tid"], state["jury_token"], BACKEND)
    assert set(qrs) == {setup[0], "https://example.github.io/qa-chgk/s/", "https://docs.google.com/spreadsheets/d/SHEET123/edit"}
    # Spread out: every pair of codes is at least 3 inches apart (centre to centre).
    points = list(qrs.values())
    for i, (x1, y1) in enumerate(points):
        for x2, y2 in points[i + 1:]:
            assert ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5 >= 3.0
    # ... and no other page has a QR code.
    for page in range(1, len(PdfReader(out).pages)):
        assert qr_texts(out, page) == [], f"page {page + 1}"
    text = text_of(out)
    assert "Доступ жюри — секретно" in text
    assert "club · club@gmail.com" in text
    assert state["tid"] in text


def test_only_the_qr_page_is_marked_secret(folder, tmp_path):
    with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    texts = page_texts(out)
    assert "лист жюри · секретно" in texts[0]
    assert all("секретно" not in t for t in texts[2:])


def test_team_forms_have_id_name_and_player_lines_only(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    forms = "\n".join(t for t in page_texts(out) if "Команды и составы" in t or "Фамилия и имя игрока" in t)
    for expected in ("A01", "Синие зайцы", "A02", "A03", "Думать быстро", "Фамилия и имя игрока"):
        assert expected in forms
    # Reserve decks R1, R2 get blank forms.
    assert forms.count("Название команды:") == 2 and "R1" in forms and "R2" in forms
    assert forms.count("Фамилия и имя игрока") == 5
    # No town, no card counts (user request).
    text = text_of(out)
    assert "Бостон" not in text and "Город" not in text and "Карточек" not in text and "Выдано" not in text


def test_reserve_section_and_grid_rows(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Команда без регистрации" in text
    assert "+ запасных комплектов: 2" in text
    grid = text[text.index("Бумажная сетка"):]
    assert "R1" in grid and "R2" in grid


def test_no_reserve_teams_no_reserve_forms(folder, tmp_path):
    config = folder / "config.py"
    config.write_text(config.read_text(encoding="utf-8").replace("spares_per_team=2,", "spares_per_team=2, reserve_teams=0,"),
                      encoding="utf-8")
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Название команды:" not in text and "Команда без регистрации" not in text and "R1" not in text


def test_backup_grid_has_every_round_and_totals(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    for expected in ("Бумажная сетка", "Тур 1 (вопросы 1–3)", "Тур 2 (вопросы 4–6)", "Итого", "Сумма", "A03"):
        assert expected in text


def test_static_text_is_printable():
    everything = "".join(JUROR_HOWTO + APPEALS_HOWTO + RESERVE_HOWTO) + GRID_LEGEND + NOT_YET + FORMS_NOTE + FORMS_RESERVE_NOTE
    assert missing_glyphs(everything) == set()


@pytest.mark.parametrize("sizes,expected", [(12, "3 × 12 = 36 вопросов"), ([12, 12, 15], "12 + 12 + 15 = 39 вопросов")])
def test_questions_line(sizes, expected):
    t = Tournament(slug="t", name="T", date=date(2026, 1, 1), rounds=3, questions_per_round=sizes,
                   scanner_url="https://e.github.io/qa-chgk/s/")
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
    sheet = "https://docs.google.com/spreadsheets/d/SHEET123/edit"
    scanner = "https://example.github.io/qa-chgk/s/"
    page1 = link_targets(out, 0)
    for url in (setup, sheet, scanner):
        assert page1.count(url) >= 2, url  # the QR code and the text under it
    assert set(page1) == {setup, sheet, scanner}
    assert decode_jury_link(setup).jury_token == state["jury_token"]
    assert {sheet, scanner} <= set(link_targets(out, 1))  # page 2 links table
