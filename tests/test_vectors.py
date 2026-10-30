import json
from pathlib import Path

VECTORS_DIR = Path(__file__).parent / "vectors"


def test_every_shared_vector_file_has_a_description_and_cases():
    for path in VECTORS_DIR.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(data["description"], str), path.name
        assert isinstance(data["cases"], list), path.name
