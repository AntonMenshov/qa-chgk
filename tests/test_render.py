import random
import re
from dataclasses import replace

import pypdfium2
import pytest
from conftest import LONG_NAME, TEAM_ROWS, TEST_GRID, read_qr, write_teams_file
from PIL import Image
from pypdf import PdfReader
from reportlab.pdfbase import pdfmetrics
from typer.testing import CliRunner

from chgk.cards.build import build_cards, build_test_page
from chgk.cards.geometry import PAGE_H, card_parts, card_rects
from chgk.cards.impose import Mode
from chgk.cards.model import Card
from chgk.cards.render import (
    ELLIPSIS,
    FONT,
    fit_text,
    logo_key,
    missing_glyphs,
    printable,
    spare_box,
)
from chgk.cli import app
from chgk.config import CardFields, LogoMode
from chgk.ids import TID_ALPHABET, CardId, decode_payload
from chgk.state import load_or_create_state, save_state
from chgk.teams import Team

DPI = 200


def page_images(pdf_path):
    doc = pypdfium2.PdfDocument(pdf_path)
    return [page.render(scale=DPI / 72).to_pil() for page in doc]


def decoded_slots(image):
    """{slot index: payload} for every QR on a rendered page, located by its centre."""
    rects = card_rects(TEST_GRID)
    scale = DPI / 72
    found = {}
    for result in read_qr(image):
        p = result.position
        cx = (p.top_left.x + p.top_right.x + p.bottom_left.x + p.bottom_right.x) / 4 / scale
        cy = PAGE_H - (p.top_left.y + p.top_right.y + p.bottom_left.y + p.bottom_right.y) / 4 / scale
        slot = next(i for i, r in enumerate(rects) if r.x <= cx <= r.right and r.y <= cy <= r.top)
        assert slot not in found, "two QR codes on one card"
        found[slot] = result.text
    return found


@pytest.mark.parametrize("mode", list(Mode))
def test_every_qr_decodes_from_the_pdf_and_sits_in_its_slot(folder, mode, tmp_path):
    out = tmp_path / "out.pdf"
    result = build_cards(folder, mode, out)
    tid = load_or_create_state(folder).tid

    seen = []
    for image in page_images(out):
        slots = decoded_slots(image)
        seen += [decode_payload(payload) for _, payload in sorted(slots.items())]
    assert len(seen) == result.cards
    assert all(card.tid == tid for card in seen)

    # Three teams plus the two reserve decks R1, R2 (config default).
    expected_numbered = {
        CardId(tid, team, question=q) for team in ("A01", "A02", "A03", "R1", "R2") for q in range(1, 7)
    }
    assert expected_numbered <= set(seen)
    assert (result.teams, result.reserve) == (3, 2)
    if mode is Mode.CUT_STACK:
        # 5 decks × (6 + 2) = 40 cards on 3 pages of 15: the 5 free slots became one more spare each.
        assert result.cards == 3 * 15 and result.pages == 3
    else:
        assert result.cards == 5 * 15 and result.pages == 5  # free slots became extra spares


def test_cut_stack_pdf_order_matches_the_guillotine_workflow(folder, tmp_path):
    out = tmp_path / "out.pdf"
    build_cards(folder, Mode.CUT_STACK, out)
    pages = [decoded_slots(image) for image in page_images(out)]
    piles = [[page[s] for page in pages if s in page] for s in range(15)]
    stacked = [decode_payload(p) for pile in piles for p in pile]
    deck = [(q, None) for q in range(1, 7)] + [(None, 1), (None, 2), (None, 3)]  # S3 fills a free slot
    expected = [(team, q, s) for team in ("A01", "A02", "A03", "R1", "R2") for q, s in deck]
    assert [(c.team_id, c.question, c.spare) for c in stacked] == expected


def _qr_slots_at(pdf, dpi):
    """Per page: the card payloads read (QR Code only) at `dpi`, each checked to sit in its own slot."""
    rects = card_rects(TEST_GRID)
    pages = []
    for page in pypdfium2.PdfDocument(pdf):
        image = page.render(scale=dpi / 72).to_pil()
        slots = {}
        for r in read_qr(image):
            p = r.position
            cx = (p.top_left.x + p.top_right.x + p.bottom_left.x + p.bottom_right.x) / 4 / (dpi / 72)
            cy = PAGE_H - (p.top_left.y + p.top_right.y + p.bottom_left.y + p.bottom_right.y) / 4 / (dpi / 72)
            slot = next(i for i, rect in enumerate(rects) if rect.x <= cx <= rect.right and rect.y <= cy <= rect.top)
            assert slot not in slots, f"two QR codes on card {slot}"
            slots[slot] = r.text
        pages.append(slots)
    return pages


def test_phantom_micro_qr_next_to_a_card_is_not_read_as_a_card(folder, tmp_path):
    """Regression: with TID SP7EM, a QR corner on A03's page also forms a valid Micro QR.

    zxing's default reading found it as a second code on one card. Read like the phone
    (QR Code only), the page holds exactly its 15 cards, one per slot.
    """
    state = load_or_create_state(folder)
    save_state(folder, replace(state, tid="SP7EM"))
    out = tmp_path / "out.pdf"
    build_cards(folder, Mode.SCISSORS, out, ["A03"])
    [slots] = _qr_slots_at(out, DPI)
    assert sorted(slots) == list(range(15))
    assert all(decode_payload(text).team_id == "A03" for text in slots.values())


@pytest.mark.parametrize("mode", list(Mode))
def test_every_card_qr_reads_back_for_many_tournament_ids(folder, tmp_path, mode):
    """Print robustness: the QR pattern depends on the random TID, so check many of them.

    For each TID (seeded, plus SP7EM) one deck is rendered at 150 dpi, coarser than any
    printer: every slot's QR code reads back (QR Code only, as on the phone) as exactly
    the card the imposition put there, and nothing else is read.
    """
    rng = random.Random(2026)
    tids = ["SP7EM"] + ["".join(rng.choice(TID_ALPHABET) for _ in range(5)) for _ in range(11)]
    decks = ["A01", "A02", "A03", "R1", "R2"]
    for k, tid in enumerate(tids):
        save_state(folder, replace(load_or_create_state(folder), tid=tid))
        out = tmp_path / f"{tid}.pdf"
        deck = decks[k % len(decks)]
        result = build_cards(folder, mode, out, [deck])
        read = [text for slots in _qr_slots_at(out, 150) for text in slots.values()]
        assert len(read) == result.cards, (tid, deck, len(read), result.cards)
        cards = [decode_payload(text) for text in read]
        assert all(c.tid == tid and c.team_id == deck for c in cards), (tid, deck)
        assert len(set(read)) == len(read), (tid, deck)  # each card once


def test_pdf_text_contains_labels_and_cyrillic(folder, tmp_path):
    out = tmp_path / "out.pdf"
    build_cards(folder, Mode.TEAM_PAGES, out)
    text = "\n".join(page.extract_text() for page in PdfReader(out).pages)
    for expected in ("Синие зайцы", "Думать быстро", "Осенний кубок", "Тур 1", "Тур 2"):
        assert expected in text
    assert "15.11.2026" not in text  # no date unless asked for (user request)
    assert "Вопрос" not in text  # the user asked for no «Вопрос» label


def test_team_filter_and_unknown_team(folder, tmp_path):
    result = build_cards(folder, Mode.CUT_STACK, tmp_path / "a.pdf", ["A03"])
    assert result.teams == 1 and result.cards == 15  # 8 cards, the rest of the page as spares
    with pytest.raises(ValueError, match="Z99"):
        build_cards(folder, Mode.CUT_STACK, tmp_path / "b.pdf", ["Z99"])


def test_unprintable_characters_warn_and_still_render(folder, tmp_path):
    write_teams_file(folder, [*TEAM_ROWS, ("A04", "Звёзды ★", "", "")])
    result = build_cards(folder, Mode.CUT_STACK, tmp_path / "out.pdf")
    assert any("★" in w for w in result.warnings)


def test_all_fixed_labels_have_glyphs():
    labels = ["Тур 0123456789", " · ", ELLIPSIS, "«»—.,-!?ёЁ"]
    assert missing_glyphs("".join(labels)) == set()
    assert missing_glyphs("АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя") == set()
    assert missing_glyphs("″→★") == {"″", "→", "★"}  # the gaps found in Phase 0


def test_printable_replaces_and_reports():
    warnings = []
    assert printable("Звёзды ★", warnings) == "Звёзды ?"
    assert len(warnings) == 1
    assert printable("Синие зайцы", warnings) == "Синие зайцы" and len(warnings) == 1


def test_fit_text():
    missing_glyphs("")  # registers the fonts
    assert fit_text("Короткое", FONT, 8, 200, 5) == ("Короткое", 8)
    text, size = fit_text(LONG_NAME, FONT, 8, 150, 5.5)
    assert size == 5.5 and text.endswith(ELLIPSIS)
    assert pdfmetrics.stringWidth(text, FONT, size) <= 150
    text, size = fit_text("Средней длины название", FONT, 8, 75, 5)
    assert 5 <= size < 8 and not text.endswith(ELLIPSIS)


@pytest.mark.parametrize(
    "mode,loaded,expected",
    [
        (LogoMode.NONE, {"A01", "tournament", "fallback"}, None),
        (LogoMode.TEAM, {"A01", "fallback"}, "A01"),
        (LogoMode.TEAM, {"tournament", "fallback"}, "fallback"),  # TEAM mode ignores the tournament logo
        (LogoMode.TEAM, set(), None),
        (LogoMode.TOURNAMENT, {"A01", "tournament", "fallback"}, "tournament"),
        (LogoMode.TOURNAMENT, {"A01", "fallback"}, "fallback"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"A01", "tournament", "fallback"}, "A01"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"tournament", "fallback"}, "tournament"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"fallback"}, "fallback"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"A02"}, None),  # another team's logo is never used
    ],
)
def test_logo_key_fallback_chain(mode, loaded, expected):
    card = Card(Team("A01", "X"), CardId("K7M2Q", "A01", question=1), 1)
    fields = CardFields(logo=mode, tournament_logo="t.png")
    assert logo_key(card, fields, {key: Image.new("L", (1, 1)) for key in loaded}) == expected


runner = CliRunner()


def test_cli_cards_with_mode(folder, tmp_path):
    out = tmp_path / "cli.pdf"
    result = runner.invoke(app, ["cards", str(folder), "--mode", "cut-stack", "--out", str(out)])
    assert result.exit_code == 0, result.output
    assert "3 teams + 2 reserve decks, 45 cards, 3 pages (cut-stack)" in result.output  # 5 free slots → spares
    assert out.read_bytes().startswith(b"%PDF")


def test_cli_cards_asks_for_mode_and_reprompts(folder, tmp_path):
    out = tmp_path / "cli.pdf"
    result = runner.invoke(app, ["cards", str(folder), "--out", str(out)], input="9\n3\n")
    assert result.exit_code == 0, result.output
    assert "How will the cards be cut?" in result.output
    assert "Please enter a number from 1 to 3." in result.output
    assert "(scissors)" in result.output


def test_cli_cards_reports_errors(folder, tmp_path):
    result = runner.invoke(
        app, ["cards", str(folder), "--mode", "scissors", "--teams", "Z99", "--out", str(tmp_path / "x.pdf")]
    )
    assert result.exit_code == 1
    assert "Z99" in result.output


@pytest.mark.parametrize("mode,dashed", [(Mode.SCISSORS, True), (Mode.TEAM_PAGES, False), (Mode.CUT_STACK, False)])
def test_only_scissors_mode_uses_dashed_cut_lines(folder, tmp_path, mode, dashed):
    out = tmp_path / "out.pdf"
    build_cards(folder, mode, out)
    content = PdfReader(out).pages[0].get_contents().get_data()
    assert (b"[4 2] 0 d" in content) is dashed


def test_test_page_has_real_qr_codes_and_marks_chosen_settings(folder, tmp_path):
    out = tmp_path / "test-page.pdf"
    result = runner.invoke(app, ["test-page", str(folder), "--out", str(out)])
    assert result.exit_code == 0, result.output
    tid = load_or_create_state(folder).tid

    (image,) = page_images(out)
    cards = {decode_payload(r.text) for r in read_qr(image)}
    # 5 QR sizes (questions 1-5) + sample cards: Q1, last question, first spare. A01 has the logo.
    assert cards == {CardId(tid, "A01", question=q) for q in (1, 2, 3, 4, 5, 6)} | {CardId(tid, "A01", spare=1)}

    text = PdfReader(out).pages[0].extract_text()
    assert "0.65 in (chosen)" in text
    assert "12% grey (chosen)" in text


def test_date_on_the_cards_only_when_switched_on(folder, tmp_path):
    config = folder / "config.py"
    config.write_text(
        config.read_text(encoding="utf-8").replace("card=CardFields(", "card=CardFields(date=True, "), encoding="utf-8"
    )
    build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")
    text = "\n".join(page.extract_text() for page in PdfReader(tmp_path / "out.pdf").pages)
    assert "Осенний кубок · 15.11.2026" in text


def test_missing_team_logo_warns_and_falls_back(folder, tmp_path):
    write_teams_file(folder, [TEAM_ROWS[0], ("A02", LONG_NAME, "", "gone.png"), TEAM_ROWS[2]])
    result = build_cards(folder, Mode.CUT_STACK, tmp_path / "out.pdf")
    assert any("team A02" in w and "gone.png" in w for w in result.warnings)


@pytest.mark.parametrize(
    "name,content,why",
    [
        ("broken.png", b"not a png", "not a readable image"),
        ("a.svg", b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "refused"),
        ("b.svg", b"<svg", "not a valid SVG"),
    ],
)
def test_unusable_team_logo_warns_and_falls_back(folder, tmp_path, name, content, why):
    (folder / name).write_bytes(content)
    write_teams_file(folder, [(TEAM_ROWS[0][0], TEAM_ROWS[0][1], "", name), *TEAM_ROWS[1:]])
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")  # no crash
    assert any("team A01" in w and name in w and why in w for w in result.warnings)
    assert build_test_page(folder, tmp_path / "test.pdf").is_file()  # the test page copes too


def test_svg_team_logo_prints_like_a_png(folder, tmp_path):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
    (folder / "owl.svg").write_text(svg, encoding="utf-8")
    write_teams_file(folder, [(TEAM_ROWS[0][0], TEAM_ROWS[0][1], "", "owl.svg"), *TEAM_ROWS[1:]])
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf", ["A01"])
    assert not any("A01" in w for w in result.warnings)
    assert len(PdfReader(result.path).pages[0].images) == 1  # one logo image, shared by A01's cards


def test_team_name_can_be_left_off_the_cards(folder, tmp_path):
    config = folder / "config.py"
    config.write_text(
        config.read_text(encoding="utf-8").replace(
            "card=CardFields(", "card=CardFields(team_name=False, logo_size=1.85, "
        ),
        encoding="utf-8",
    )
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")
    text = "\n".join(page.extract_text() for page in PdfReader(result.path).pages)
    assert "Синие зайцы" not in text and "Думать быстро" not in text
    assert "Осенний кубок" in text  # the other footer fields stay
    assert "Синие зайцы" in "\n".join(
        p.extract_text() for p in PdfReader(result.jury_path).pages
    )  # jury still sees names


def test_spare_cards_have_an_empty_number_box_and_no_words(folder, tmp_path):
    out = tmp_path / "out.pdf"
    build_cards(folder, Mode.TEAM_PAGES, out)
    text = "\n".join(page.extract_text() for page in PdfReader(out).pages)
    assert "Запас" not in text and "№" not in text

    # Page 1 is team A01: slots 0-5 are questions 1-6, slot 6 is the first spare.
    image = page_images(out)[0].convert("L")
    scale = DPI / 72
    rect = card_rects(TEST_GRID)[6]
    box = spare_box(card_parts(rect, 0.65 * 72).number)

    def px(x, y):
        return image.getpixel((round(x * scale), round((PAGE_H - y) * scale)))

    mid_x, mid_y = box.x + box.w / 2, box.y + box.h / 2
    assert max(px(box.x, mid_y), px(box.right, mid_y), px(mid_x, box.y), px(mid_x, box.top)) < 160  # the outline
    assert min(px(mid_x, mid_y), px(box.x + 8, box.top - 8)) > 200  # empty inside


def test_spare_box_is_white_inside_over_a_big_centred_logo(folder, tmp_path):
    """User report: the box outline ran across the logo.

    The box is filled white, so nothing of a big centred logo shows inside it.
    """
    config = folder / "config.py"
    text = config.read_text(encoding="utf-8")
    assert "card=CardFields(" in text
    config.write_text(
        text.replace("card=CardFields(", "card=CardFields(logo_size=1.85, logo_grey=0.5, "), encoding="utf-8"
    )
    out = tmp_path / "out.pdf"
    build_cards(folder, Mode.TEAM_PAGES, out)
    image = page_images(out)[0].convert("L")
    scale = DPI / 72
    rect = card_rects(TEST_GRID)[6]
    parts = card_parts(rect, 0.65 * 72, 1.85 * 72)
    box = spare_box(parts.number)
    assert parts.logo.intersects(box)  # the logo does reach under the box ...
    inside = [
        image.getpixel((round(x * scale), round((PAGE_H - y) * scale)))
        for x in range(round(box.x + 4), round(box.right - 4), 3)
        for y in range(round(box.y + 4), round(box.top - 4), 3)
    ]
    assert min(inside) > 245  # ... but the box stays white


# ---- reserve decks (teams that turn up unregistered) ----


def test_reserve_cards_have_a_name_line_and_the_generic_logo(folder, tmp_path):
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")
    pages = [page.extract_text() for page in PdfReader(result.path).pages]
    # Pages 4 and 5 are R1 and R2: no team name, a «Команда:» line to write it on.
    for text in pages[3:]:
        assert text.count("Команда:") == 15
        assert "Синие зайцы" not in text
    assert all("Команда:" not in text for text in pages[:3])
    # A reserve team has no logo of its own: tournament logo first, then the fallback.
    card = Card(Team("R1", "", reserve=True), CardId("K7M2Q", "R1", question=1), 1)
    loaded = {key: Image.new("L", (1, 1)) for key in ("A01", "tournament", "fallback")}
    assert (
        logo_key(card, CardFields(logo=LogoMode.TEAM_ELSE_TOURNAMENT, tournament_logo="t.png"), loaded) == "tournament"
    )


def test_reserve_cards_without_team_names_on_cards(folder, tmp_path):
    config = folder / "config.py"
    config.write_text(
        config.read_text(encoding="utf-8").replace("card=CardFields(", "card=CardFields(team_name=False, "),
        encoding="utf-8",
    )
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")
    pages = [page.extract_text() for page in PdfReader(result.path).pages]
    assert "Команда:" not in "\n".join(pages)
    # Without a name line, each reserve card still carries its deck's ID (user request);
    # registered teams' cards don't show theirs.
    for deck, text in zip(("R1", "R2"), pages[3:], strict=True):
        assert len(re.findall(rf"\b{deck}\b", text)) == 15, deck
        assert text.count("Осенний кубок") == 15
    assert not re.search(r"\b(A0[123]|R[12])\b", "\n".join(pages[:3]))


def test_reserve_decks_can_be_printed_alone(folder, tmp_path):
    result = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf", ["R2"])
    assert (result.teams, result.reserve, result.pages) == (0, 1, 1)


def test_a_team_id_that_clashes_with_a_reserve_id_is_an_error(folder, tmp_path):
    write_teams_file(folder, [*TEAM_ROWS[:2], ("R2", "Думать быстро", "", "")])
    with pytest.raises(ValueError, match="R2 is kept for reserve teams"):
        build_cards(folder, Mode.TEAM_PAGES, tmp_path / "out.pdf")
    result = runner.invoke(app, ["cards", str(folder), "--mode", "team-pages", "--out", str(tmp_path / "x.pdf")])
    assert result.exit_code == 1 and "reserve" in result.output
