import json
from pathlib import Path

import pytest

from chgk.ids import (
    TID_ALPHABET,
    TID_LENGTH,
    BoardAccess,
    CardId,
    JuryAccess,
    PayloadError,
    assign_team_ids,
    board_page_url,
    decode_board_link,
    decode_jury_link,
    decode_payload,
    encode_board_link,
    encode_jury_link,
    encode_payload,
    generate_jury_token,
    generate_tid,
)

VECTORS = json.loads((Path(__file__).parent / "vectors" / "qr_payloads.json").read_text(encoding="utf-8"))
VALID = [c for c in VECTORS["cases"] if c["valid"]]
INVALID = [c for c in VECTORS["cases"] if not c["valid"]]


@pytest.mark.parametrize("case", VALID, ids=lambda c: c["payload"])
def test_valid_payloads_decode(case):
    card = decode_payload(case["payload"])
    assert (card.tid, card.team_id, card.question, card.spare) == (
        case["tid"], case["team_id"], case["question"], case["spare"]
    )


@pytest.mark.parametrize("case", [c for c in VALID if c["payload"].startswith("https://")], ids=lambda c: c["payload"])
def test_valid_payloads_encode_identically(case):
    card = CardId(case["tid"], case["team_id"], question=case["question"], spare=case["spare"])
    assert encode_payload(VECTORS["scanner_url"], card) == case["payload"]


@pytest.mark.parametrize("case", INVALID, ids=lambda c: c["note"])
def test_invalid_payloads_are_rejected(case):
    with pytest.raises(PayloadError):
        decode_payload(case["payload"])


def test_card_needs_exactly_one_of_question_or_spare():
    with pytest.raises(ValueError):
        CardId("K7M2Q", "A07")
    with pytest.raises(ValueError):
        CardId("K7M2Q", "A07", question=1, spare=1)


def test_generated_tid_uses_unambiguous_alphabet():
    for _ in range(200):
        tid = generate_tid()
        assert len(tid) == TID_LENGTH
        assert set(tid) <= set(TID_ALPHABET)
        assert decode_payload(f"{tid}.A01.1").tid == tid


def test_assign_team_ids_fills_gaps_and_keeps_existing():
    assert assign_team_ids([None, None, None]) == ["A01", "A02", "A03"]
    assert assign_team_ids([None, "A01", None]) == ["A02", "A01", "A03"]
    assert assign_team_ids(["B05", None]) == ["B05", "A01"]


def test_assign_team_ids_rolls_over_to_next_letter():
    ids = assign_team_ids([None] * 100)
    assert ids[98] == "A99"
    assert ids[99] == "B01"
    assert len(set(ids)) == 100


def test_given_ids_are_kept_and_only_blanks_are_assigned():
    """The user's case: rating IDs for three teams, none for the fourth."""
    assert assign_team_ids(["645", "58746", "40400", None]) == ["645", "58746", "40400", "A01"]
    assert assign_team_ids([None, "A01", "7", None]) == ["A02", "A01", "7", "A03"]


def test_given_ids_are_normalised():
    assert assign_team_ids([" a07 ", "  ", "b1"]) == ["A07", "A01", "B1"]


@pytest.mark.parametrize("bad", [["A01", "A01"], ["645", " 645"], ["a01", "A01"], ["A-1"], ["ABCDEFGHI"], ["58 746"],
                                 ["А01"], ["A.1"]])
def test_assign_team_ids_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        assign_team_ids(bad)


JURY = json.loads((Path(__file__).parent / "vectors" / "jury_links.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", [c for c in JURY["cases"] if c["valid"]], ids=lambda c: c["link"][-30:])
def test_jury_links_decode(case):
    access = decode_jury_link(case["link"])
    assert access == JuryAccess(case["tid"], case["jury_token"], case["backend_url"])
    if case["link"].startswith("https://"):
        assert encode_jury_link(JURY["scanner_url"], access) == case["link"]


@pytest.mark.parametrize("case", [c for c in JURY["cases"] if not c["valid"]], ids=lambda c: c["note"])
def test_invalid_jury_links(case):
    with pytest.raises(PayloadError):
        decode_jury_link(case["link"])


def test_generated_jury_token_round_trips():
    access = JuryAccess("K7M2Q", generate_jury_token(), "https://script.google.com/macros/s/AKfycbx_Example-123/exec")
    assert decode_jury_link(encode_jury_link("https://e.github.io/qa-chgk/s/", access)) == access


def test_jury_link_rejects_non_apps_script_backend():
    with pytest.raises(ValueError):
        encode_jury_link("https://e.github.io/qa-chgk/s/", JuryAccess("K7M2Q", generate_jury_token(), "https://evil.example/exec"))


BOARD = json.loads((Path(__file__).parent / "vectors" / "board_links.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", [c for c in BOARD["cases"] if c["valid"]], ids=lambda c: c["link"][-30:])
def test_board_links_decode(case):
    access = decode_board_link(case["link"])
    assert access == BoardAccess(case["tid"], case["board_token"], case["backend_url"])
    if case["grid"] is not None:
        assert encode_board_link("https://example.github.io/qa-chgk/s/", access, case["grid"]) == case["link"]


@pytest.mark.parametrize("case", [c for c in BOARD["cases"] if not c["valid"]], ids=lambda c: c["note"])
def test_invalid_board_links(case):
    with pytest.raises(PayloadError):
        decode_board_link(case["link"])


def test_board_page_sits_next_to_the_scanner():
    assert board_page_url("https://antonmenshov.github.io/qa-chgk/s/") == "https://antonmenshov.github.io/qa-chgk/b/"
