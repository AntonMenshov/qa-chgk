"""The real backend code for the Python tests, answering for one web app URL.

tests/js/fake_backend_server.mjs (apps_script/ on fake Google services) runs in a Node
process and answers through respx. So the CLI is tested against what the backend really
does, not a hand-written stand-in that could drift from it.
"""

import json
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

import httpx

SERVER = Path(__file__).resolve().parent / "js" / "fake_backend_server.mjs"
NODE = shutil.which("node")


class NodeBackend:
    """One Google account's backend. `token_alias` (the admin token a test types) is replaced by the real one."""

    def __init__(self, url: str, account: str, token_alias: str):
        self.url, self.account, self.token_alias = url, account, token_alias
        self.calls: list[dict] = []  # every request the CLI sent, as sent
        env = {**os.environ, "CHGK_FAKE_ACCOUNT": account}
        self.proc = subprocess.Popen(
            [NODE, str(SERVER)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        line = self.proc.stdout.readline()
        assert line.startswith("READY"), self.proc.stderr.read()
        _, port, self.admin_token = line.split()
        self.base = f"http://127.0.0.1:{port}"

    def _post(self, path: str, payload: dict) -> dict:
        request = urllib.request.Request(self.base + path, data=json.dumps(payload).encode(), method="POST")
        with urllib.request.urlopen(request) as r:
            return json.loads(r.read())

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Respx side effect: what the web app at `url` answers."""
        assert request.headers["content-type"].startswith("text/plain")
        payload = json.loads(request.content)
        self.calls.append(payload)
        if payload.get("token") == self.token_alias:
            payload = {**payload, "token": self.admin_token}
        return httpx.Response(200, json=self._post("", payload))

    def call(self, action: str, token: str | None = None, **payload) -> dict:
        """A request straight to the backend (not logged in `calls`), with the admin token by default."""
        return self._post("", {"action": action, "token": token or self.admin_token, **payload})

    def options(self, **options) -> None:
        """allScopes=False: a Google permission left unticked; sheetsApi=False: the service off."""
        self._post("/__options", options)

    def set_cell(self, tid: str, tab: str, row: int, col: int, value) -> None:
        """Someone typing in the Sheet (the edit trigger doesn't run)."""
        self._post("/__set_cell", {"tid": tid, "tab": tab, "row": row, "col": col, "value": value})

    def close(self) -> None:
        self.proc.kill()
        self.proc.communicate(timeout=10)
