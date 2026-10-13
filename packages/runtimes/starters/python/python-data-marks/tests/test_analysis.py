import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis import load, summary  # noqa: E402


def test_summary_per_subject():
    table = summary(load())
    assert table.loc["Maths", "best"] == 92
    assert table.loc["Physics", "average"] == 69.0
