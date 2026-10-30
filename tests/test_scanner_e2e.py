"""The scanner web app end to end, in a real (headless) Chrome.

Chrome's fake camera plays a video made of real printed cards (cut from the cards PDF),
the page talks to the fake Apps Script backend (tests/js/fake_backend_server.mjs) and the
test taps the verdicts like a juror. Skipped when Google Chrome or Node is missing.
"""

import base64
import io
import json
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar

import pypdfium2
import pytest
import segno
import zxingcpp
from PIL import Image

from chgk.cards.build import build_cards
from chgk.cards.geometry import PAGE_H, card_rects
from chgk.cards.impose import Mode
from chgk.config import Layout
from chgk.ids import BoardAccess, JuryAccess, encode_board_link, encode_jury_link
from chgk.state import load_or_create_state

ROOT = Path(__file__).resolve().parent.parent
CHROME = next(
    (
        p
        for p in (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            shutil.which("google-chrome"),
            shutil.which("google-chrome-stable"),
        )
        if p and Path(p).exists()
    ),
    None,
)
playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not (CHROME and shutil.which("node")), reason="needs Google Chrome and Node")

BACKEND = "https://script.google.com/macros/s/AKfycbE2E_TEST_DEPLOYMENT_0001/exec"
JURY_TOKEN = "e2eJuryToken_0123456789ab"
BOARD_TOKEN = "e2eBoardToken_0123456789a"
DPI = 150
FPS_FRAMES_CARD, FPS_FRAMES_GAP = 40, 25


def card_image(pdf: Path, page: int, slot: int) -> Image.Image:
    """One printed card, cut from a page of the cards PDF."""
    image = pypdfium2.PdfDocument(pdf)[page].render(scale=DPI / 72).to_pil().convert("RGB")
    r = card_rects(Layout())[slot]
    k = DPI / 72
    return image.crop((round(r.x * k), round((PAGE_H - r.top) * k), round(r.right * k), round((PAGE_H - r.y) * k)))


def qr_image(payload: str) -> Image.Image:
    buf = io.BytesIO()
    segno.make_qr(payload, error="m").save(buf, kind="png", scale=6, border=4)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


def write_video(path: Path, cards: list[Image.Image]) -> None:
    """MJPEG for Chrome's fake camera: each card on a table for a moment, then the table alone."""
    table = Image.new("RGB", (1280, 720), (92, 74, 58))
    frames = []
    for card in cards:
        scale = 560 / card.height
        shown = card.resize((round(card.width * scale), 560))
        frame = table.copy()
        frame.paste(shown, ((1280 - shown.width) // 2, 80))
        frames += [frame] * FPS_FRAMES_CARD + [table] * FPS_FRAMES_GAP
    with path.open("wb") as f:
        for frame in frames:
            buf = io.BytesIO()
            frame.save(buf, "JPEG", quality=85)
            f.write(buf.getvalue())


@pytest.fixture
def backend_server(folder):
    state = load_or_create_state(folder)
    create = {
        "tid": state.tid,
        "name": "Осенний кубок",
        "date": "2026-11-15",
        "round_sizes": [3, 3],
        "jury_token": JURY_TOKEN,
        "teams": [
            {"team_id": "A01", "name": "Синие зайцы"},
            {"team_id": "A02", "name": "Команда с очень-очень длинным названием «Правило трёх буравчиков»"},
            {"team_id": "A03", "name": "Думать быстро"},
        ],
        "reserve": ["R1", "R2"],
        "board_token": BOARD_TOKEN,
    }
    proc = subprocess.Popen(
        ["node", str(ROOT / "tests/js/fake_backend_server.mjs"), json.dumps(create, ensure_ascii=False)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline()
    assert line.startswith("READY"), proc.stderr.read()
    url = f"http://127.0.0.1:{line.split()[1]}"

    def call(action, **payload):
        body = json.dumps({"action": action, **payload}).encode()
        with urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST")) as r:
            return json.loads(r.read())

    yield state.tid, url, call
    proc.kill()
    proc.communicate(timeout=10)  # reap it and close its pipes


@pytest.fixture
def web_server():
    class Handler(SimpleHTTPRequestHandler):
        extensions_map: ClassVar[dict[str, str]] = {
            **SimpleHTTPRequestHandler.extensions_map,
            ".wasm": "application/wasm",
            ".js": "text/javascript",
            ".webmanifest": "application/manifest+json",
        }

        def log_message(self, *args):
            pass

    class Server(ThreadingHTTPServer):
        # Chrome fetches the scanner's ~13 module files at once; the default backlog of 5
        # occasionally reset one (ERR_CONNECTION_RESET), and the page never started.
        request_queue_size = 128
        daemon_threads = True

    server = Server(("127.0.0.1", 0), partial(Handler, directory=str(ROOT / "web")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_jury_scans_cards_and_marks_reach_the_backend(folder, tmp_path, backend_server, web_server):
    tid, backend_url, call = backend_server
    pdf = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "cards.pdf").path
    # team-pages: one page per deck (A01, A02, A03, R1, R2); slots 0-5 = questions 1-6, 6+ spares.
    cards = [
        card_image(pdf, 0, 0),  # A01, question 1
        card_image(pdf, 1, 0),  # A02, question 1
        card_image(pdf, 0, 6),  # A01, spare S1 → the juror says question 2
        card_image(pdf, 3, 1),  # R1 (reserve deck), question 2
        qr_image("https://example.github.io/qa-chgk/s/#ZZZZZ.A01.1"),  # another tournament's card
    ]
    video = tmp_path / "cards.mjpeg"
    write_video(video, cards)

    scanner = f"{web_server}/s/"
    link = encode_jury_link(scanner, JuryAccess(tid, JURY_TOKEN, BACKEND))
    console = []
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-video-capture={video}",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        context = browser.new_context(permissions=["camera"], viewport={"width": 390, "height": 844})

        def to_backend(route):
            request = route.request
            body = request.post_data.encode() if request.method == "POST" else None
            with urllib.request.urlopen(urllib.request.Request(backend_url, data=body, method=request.method)) as r:
                route.fulfill(
                    status=200,
                    body=r.read(),
                    headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
                )

        context.route("https://script.google.com/**", to_backend)
        page = context.new_page()
        page.on("console", lambda m: console.append(m.text))
        page.on("pageerror", lambda e: console.append(f"pageerror: {e}"))
        # The scanner is already open (setup screen); then the jury link is opened in the same
        # tab, which only changes the #… part of the address (no reload).
        page.goto(scanner)
        page.wait_for_selector("#setup:not([hidden])", timeout=15000)
        page.goto(link)

        page.wait_for_selector("#main:not([hidden])", timeout=15000)
        assert "#" not in page.url  # the jury token is removed from the address bar
        assert page.inner_text("#t-name") == "Осенний кубок"
        assert page.inner_text("#q-num") == "1"
        page.click("#start")

        verdicts = {
            ("Синие зайцы", 1): "#v-correct",
            ("Команда с", 1): "#v-incorrect",
            ("Синие зайцы", 2): "#v-disputed",
            ("R1 · впишите название", 2): "#v-correct",
        }
        handled, warnings, foreign = {}, {}, False
        deadline = time.time() + 90
        while time.time() < deadline and (len(handled) < len(verdicts) or not foreign):
            if page.is_visible("#spare"):
                assert page.inner_text("#sp-team") == "Синие зайцы"
                page.click('.keypad button[data-k="2"]')
                page.click('.keypad button[data-k="ok"]')
            elif page.is_visible("#card"):
                team = page.inner_text("#c-team")
                question = int(re.search(r"Вопрос (\d+)", page.inner_text("#c-meta"))[1])
                key = next((k for k in verdicts if team.startswith(k[0]) and k[1] == question), None)
                assert key, f"unexpected card {team!r} {question}"
                if key in handled:
                    page.click("#v-later")  # the same card again (the video loops): only "received"
                else:
                    warnings[key] = page.inner_text("#c-warn")
                    handled[key] = page.inner_text("#c-meta")
                    page.click(verdicts[key])
            if page.is_visible("#toast") and "другого турнира" in page.inner_text("#toast"):
                foreign = True
            time.sleep(0.1)
        assert set(handled) == set(verdicts), (handled, console)
        assert foreign, console

        # The spare card was marked as a spare for the juror's question; R1 got the reserve note.
        assert "запасная карточка" in handled[("Синие зайцы", 2)]
        assert "Запасной комплект R1" in warnings[("R1 · впишите название", 2)]
        # The current question followed the cards up to 2.
        assert page.inner_text("#q-num") == "2"

        page.wait_for_function("document.getElementById('sync').textContent.includes('отправлено')", timeout=20000)

        # Phase 4: one photo per card (the looping video shows cards again: no second photo),
        # uploaded in the background under a Latin name, showing that very card.
        photos = []
        deadline = time.time() + 30
        while time.time() < deadline and len(photos) < 4:
            with urllib.request.urlopen(f"{backend_url}/__photos") as r:
                photos = json.loads(r.read())
            time.sleep(0.3)
        page.wait_for_function("!document.getElementById('sync').textContent.includes('фото')", timeout=20000)
        page.wait_for_function("!document.getElementById('missing-open').textContent.includes('R1')", timeout=5000)
        page.click("#missing-open")
        missing = page.inner_text("#m-list")
        page.click("#m-close")

        # «Чья карточка?»: the same cards (the video loops) are only described, not recorded.
        marks_before = call("get_state", tid=tid, token=JURY_TOKEN)["marks"]
        page.click("#lookup-open")
        seen = {}
        deadline = time.time() + 60
        while time.time() < deadline and not ({"Синие зайцы", "Карточка другого турнира"} <= set(seen)):
            title = page.inner_text("#lk-title")
            seen.setdefault(title, set()).add(page.inner_text("#lk-details"))
            time.sleep(0.1)
        assert page.is_hidden("#card") and page.is_hidden("#spare"), seen
        assert "Вопрос 1 · тур 1\nID A01\nОтметка: верно" in seen.get("Синие зайцы", set()), seen
        assert any("Турнир ZZZZZ" in d for d in seen.get("Карточка другого турнира", set())), seen
        page.click("#lk-close")
        time.sleep(1.5)
        assert page.inner_text("#sync").endswith("отправлено")
        browser.close()
    assert call("get_state", tid=tid, token=JURY_TOKEN)["marks"] == marks_before

    # Question 2: A01 (spare) and R1 handed in; A02 and A03 did not. R2 never played.
    assert "Правило трёх буравчиков" in missing and "Думать быстро" in missing
    assert "Синие зайцы" not in missing and "R2" not in missing

    marks = call("get_state", tid=tid, token=JURY_TOKEN)["marks"]
    assert marks["A01"][:2] == [1, "?"]
    assert marks["A02"][:2] == [0, ""]
    assert marks["R1"][:2] == ["", 1]
    assert marks["A03"] == [""] * 6
    standings = call("get_results", tid=tid, token=JURY_TOKEN)["standings"]
    assert [(r["team_id"], r["total"], r["place"]) for r in standings] == [
        ("A01", 1, "1-2"),
        ("R1", 1, "1-2"),
        ("A02", 0, "3-4"),
        ("A03", 0, "3-4"),
    ]  # 1 and 1, both in round 1: ID order
    assert not [line for line in console if "pageerror" in line], console

    with urllib.request.urlopen(f"{backend_url}/__photos") as r:
        assert len(json.loads(r.read())) == 4  # «Чья карточка?» took no photos
    names = sorted(p["name"] for p in photos)
    pattern = re.compile(rf"^{tid}_(A01|A02|R1)_q00[12](_S1)?_\d{{8}}-\d{{6}}_[0-9a-f]{{8}}\.jpg$")
    assert len(names) == 4 and all(pattern.match(n) for n in names), names
    assert [n.split("_q")[0] for n in names] == [f"{tid}_A01", f"{tid}_A01", f"{tid}_A02", f"{tid}_R1"], names
    assert sum("_q002_S1_" in n for n in names) == 1  # the spare card, filed under the juror's question
    for p in photos:
        image = Image.open(io.BytesIO(base64.b64decode(p["base64"])))
        assert image.format == "JPEG" and max(image.size) <= 1600, (p["name"], image.size)
        seen = [r.text for r in zxingcpp.read_barcodes(image)]
        card = p["name"].split("_")[1]
        assert any(f"{tid}.{card}." in text for text in seen), (p["name"], seen)  # the photo shows the card
    log = call("get_state", tid=tid, token=JURY_TOKEN)  # still consistent after the photo rows in Log
    assert log["marks"]["A01"][:2] == [1, "?"]


def test_projector_board_reveals_round_by_round(folder, tmp_path, backend_server, web_server):
    """The board shows nothing until → is pressed; then each round, with places from revealed rounds only."""
    tid, backend_url, call = backend_server
    marks = {  # rounds of 3 questions: (team, question) → status
        ("A01", 1): "correct",
        ("A01", 2): "correct",
        ("A02", 1): "correct",
        ("A03", 3): "incorrect",
        ("A03", 4): "correct",
        ("A03", 5): "correct",
        ("A03", 6): "correct",
        ("A02", 4): "disputed",
    }
    events = [
        {"scan_id": f"e{i}", "team_id": t, "question": q, "status": st, "client_ts": 1_700_000_000_000 + i}
        for i, ((t, q), st) in enumerate(marks.items())
    ]
    assert call("record_events", tid=tid, token=JURY_TOKEN, events=events)["ok"]

    # The same link the jury sheet prints (chgk/ids.py), with the test server as the scanner's site.
    link = encode_board_link(f"{web_server}/s/", BoardAccess(tid, BOARD_TOKEN, BACKEND), 5)
    view_url = call("get_board", tid=tid, token=BOARD_TOKEN)["view_url"]
    assert re.fullmatch(r"https://docs\.google\.com/spreadsheets/d/[\w-]+/htmlview", view_url)  # as State.view_url
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_context(viewport={"width": 1280, "height": 720}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        def to_backend(route):
            with urllib.request.urlopen(
                urllib.request.Request(backend_url, data=route.request.post_data.encode(), method="POST")
            ) as r:
                route.fulfill(
                    status=200,
                    body=r.read(),
                    headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
                )

        page.route("https://script.google.com/**", to_backend)
        page.goto(link)
        page.wait_for_selector("text=Результаты появятся после первого тура")

        def codes():
            """The QR codes on screen, decoded from a screenshot (as a phone in the hall would)."""
            image = Image.open(io.BytesIO(page.screenshot())).convert("L")
            return sorted(r.text for r in zxingcpp.read_barcodes(image))

        # Title screen: both QR codes, large: the same links as page 2 of the jury sheet.
        assert codes() == sorted([link, view_url])

        def rows():
            return [
                [td.inner_text() for td in tr.query_selector_all("td.place, td.team, td.total")]
                for tr in page.query_selector_all("tbody tr")
            ]

        page.keyboard.press("ArrowRight")
        page.wait_for_selector("text=после 1-го тура из 2")
        # Round 1 only: A01 2, A02 1, A03 0 (its round-2 points stay hidden).
        assert [[*r[:2], r[2]] for r in rows()] == [
            ["1", "Синие зайцы", "2"],
            ["2", "Команда с очень-очень длинным названием «Правило трёх буравчиков»", "1"],
            ["3", "Думать быстро", "0"],
        ]
        assert page.inner_text("tfoot").split()[:4] == ["Взяли", "2", "1", "0"]
        assert codes() == sorted([link, view_url])  # beside the results too
        page.keyboard.press("q")  # Q hides them (and shows them again)
        assert page.query_selector(".qrs") is None and codes() == []
        page.keyboard.press("q")
        assert len(page.query_selector_all(".qrs figure")) == 2

        page.keyboard.press(" ")
        page.wait_for_selector("text=после 2 туров из 2")
        # A03 now 3 and first; A01 2; A02 1 (its «?» shows as ? and doesn't count).
        assert [r[0] + " " + r[2] for r in rows()] == ["1 3", "2 2", "3 1"]
        assert "?" in page.inner_text("tbody")
        assert page.is_disabled("#next")

        page.keyboard.press("g")  # compact: only the last round's grid
        assert page.inner_text("thead").count("Тур") == 1 and "Тур 2" in page.inner_text("thead")
        page.reload()  # the revealed round and the view survive a reload
        page.wait_for_selector("text=после 2 туров из 2")
        assert page.inner_text("thead").count("Тур") == 1
        page.keyboard.press("ArrowLeft")
        page.wait_for_selector("text=после 1-го тура из 2")
        browser.close()
    assert not errors, errors
