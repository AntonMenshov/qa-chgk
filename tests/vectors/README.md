# Shared test vectors

JSON files here are checked by **both** the Python tests (`uv run pytest`) and the
JS tests (`npm test`), so the Python card generator and the JS scanner/backend
agree on formats (QR payloads, jury and board links, merge rules).

Each file is an object with a `"description"` string and a `"cases"` array.
