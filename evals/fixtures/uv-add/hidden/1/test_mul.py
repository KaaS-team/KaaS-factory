import sys

sys.path.insert(0, "src")

from u import mul


def test_mul():
    assert mul(3, 4) == 12
