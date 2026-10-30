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
from chgk.jury import APPEALS_HOWTO, GRID_LEGEND, JUROR_HOWTO, NOT_YET, _questions_line
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


def test_without_backend_shows_placeholder_and_no_secret(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    assert "Доступ жюри ещё не создан" in text
    assert NOT_YET in text
    assert qr_texts(out) == ["https://example.github.io/qa-chgk/s/"]  # only the scanner link


def test_with_backend_has_working_jury_qr_and_links(folder, tmp_path):
    state = with_backend(folder)
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    qrs = qr_texts(out)
    setup = [q for q in qrs if "#setup=" in q]
    assert len(setup) == 1
    access = decode_jury_link(setup[0])
    assert (access.tid, access.jury_token, access.backend_url) == (state["tid"], state["jury_token"], BACKEND)
    assert "https://docs.google.com/spreadsheets/d/SHEET123/edit" in qrs
    text = text_of(out)
    assert "Доступ жюри — секретно" in text
    assert "club · club@gmail.com" in text
    assert state["tid"] in text


def test_roster_counts_follow_the_imposition(folder, tmp_path):
    # 2 rounds × 3 questions + 2 spares = 8 cards; team-pages pads to 15 → 9 spares.
    out, _ = build_jury_sheet(folder, Mode.TEAM_PAGES, tmp_path / "a.pdf")
    roster = PdfReader(out).pages[1].extract_text()
    assert "A01" in roster and "Синие зайцы" in roster and "Бостон" in roster
    assert "6 9" in roster.replace("\n", " ")
    out, _ = build_jury_sheet(folder, None, tmp_path / "b.pdf")
    assert "6 2" in PdfReader(out).pages[1].extract_text().replace("\n", " ")


def test_backup_grid_has_every_round_and_totals(folder, tmp_path):
    out, _ = build_jury_sheet(folder, out=tmp_path / "jury.pdf")
    text = text_of(out)
    for expected in ("Бумажная сетка", "Тур 1 (вопросы 1–3)", "Тур 2 (вопросы 4–6)", "Итого", "Сумма", "A03"):
        assert expected in text


def test_static_text_is_printable():
    everything = "".join(JUROR_HOWTO + APPEALS_HOWTO) + GRID_LEGEND + NOT_YET
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
