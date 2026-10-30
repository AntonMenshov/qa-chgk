"""The scanner web app end to end, in a real (headless) Chrome.

Chrome's fake camera plays a video made of real printed cards (cut from the cards PDF),
the page talks to the fake Apps Script backend (tests/js/fake_backend_server.mjs) and the
test taps the verdicts like a juror. Skipped when Google Chrome or Node is missing.
"""

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

import pypdfium2
import pytest
import segno
from PIL import Image

from chgk.cards.build import build_cards
from chgk.cards.geometry import PAGE_H, card_rects
from chgk.cards.impose import Mode
from chgk.config import Layout
from chgk.ids import JuryAccess, encode_jury_link
from chgk.state import load_or_create_state

ROOT = Path(__file__).resolve().parent.parent
CHROME = next((p for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                           shutil.which("google-chrome"), shutil.which("google-chrome-stable")) if p and Path(p).exists()), None)
playwright = pytest.importorskip("playwright.sync_api")
pytestmark = pytest.mark.skipif(not (CHROME and shutil.which("node")), reason="needs Google Chrome and Node")

BACKEND = "https://script.google.com/macros/s/AKfycbE2E_TEST_DEPLOYMENT_0001/exec"
JURY_TOKEN = "e2eJuryToken_0123456789ab"
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
        "tid": state.tid, "name": "Осенний кубок", "date": "2026-11-15", "round_sizes": [3, 3], "jury_token": JURY_TOKEN,
        "teams": [{"team_id": "A01", "name": "Синие зайцы"}, {"team_id": "A02", "name": "Команда с очень-очень длинным названием «Правило трёх буравчиков»"},
                  {"team_id": "A03", "name": "Думать быстро"}],
        "reserve": ["R1", "R2"],
    }
    proc = subprocess.Popen(["node", str(ROOT / "tests/js/fake_backend_server.mjs"), json.dumps(create, ensure_ascii=False)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = proc.stdout.readline()
    assert line.startswith("READY"), proc.stderr.read()
    url = f"http://127.0.0.1:{line.split()[1]}"

    def call(action, **payload):
        body = json.dumps({"action": action, **payload}).encode()
        with urllib.request.urlopen(urllib.request.Request(url, data=body, method="POST")) as r:
            return json.loads(r.read())

    yield state.tid, url, call
    proc.kill()


@pytest.fixture
def web_server():
    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm",
                          ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT / "web")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_jury_scans_cards_and_marks_reach_the_backend(folder, tmp_path, backend_server, web_server):
    tid, backend_url, call = backend_server
    pdf = build_cards(folder, Mode.TEAM_PAGES, tmp_path / "cards.pdf").path
    # team-pages: one page per deck (A01, A02, A03, R1, R2); slots 0-5 = questions 1-6, 6+ spares.
    cards = [
        card_image(pdf, 0, 0),  # A01, question 1
        card_image(pdf, 1, 0),  # A02, question 1
        card_image(pdf, 0, 6),  # A01, spare S1 → the juror says question 2
        card_image(pdf, 3, 1),  # R1 (reserve deck), question 2
        qr_image(f"https://example.github.io/qa-chgk/s/#ZZZZZ.A01.1"),  # another tournament's card
    ]
    video = tmp_path / "cards.mjpeg"
    write_video(video, cards)

    scanner = f"{web_server}/s/"
    link = encode_jury_link(scanner, JuryAccess(tid, JURY_TOKEN, BACKEND))
    console = []
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-video-capture={video}", "--autoplay-policy=no-user-gesture-required"])
        context = browser.new_context(permissions=["camera"], viewport={"width": 390, "height": 844})

        def to_backend(route):
            request = route.request
            body = request.post_data.encode() if request.method == "POST" else None
            with urllib.request.urlopen(urllib.request.Request(backend_url, data=body, method=request.method)) as r:
                route.fulfill(status=200, body=r.read(), headers={"Content-Type": "application/json",
                                                                  "Access-Control-Allow-Origin": "*"})

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

        verdicts = {("Синие зайцы", 1): "#v-correct", ("Команда с", 1): "#v-incorrect",
                    ("Синие зайцы", 2): "#v-disputed", ("R1 · впишите название", 2): "#v-correct"}
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
        page.wait_for_function("!document.getElementById('missing-open').textContent.includes('R1')", timeout=5000)
        page.click("#missing-open")
        missing = page.inner_text("#m-list")
        page.click("#m-close")
        browser.close()

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
        ("A01", 1, "1-2"), ("R1", 1, "1-2"), ("A02", 0, "3-4"), ("A03", 0, "3-4")]  # 1 and 1, both in round 1: ID order
    assert not [line for line in console if "pageerror" in line], console
