import json
from pathlib import Path

import pytest

from chgk.ids import (
    TID_ALPHABET,
    TID_LENGTH,
    CardId,
    PayloadError,
    assign_team_ids,
    decode_payload,
    encode_payload,
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


@pytest.mark.parametrize("bad", [["A01", "A01"], ["a01"], ["A1"], ["A100"]])
def test_assign_team_ids_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        assign_team_ids(bad)
