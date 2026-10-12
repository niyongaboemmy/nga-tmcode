import pytest

from shop import Cart


def test_total_adds_price_times_quantity():
    cart = Cart()
    cart.add("notebook", 500, 3)
    cart.add("pen", 200)
    assert cart.total() == 1700


def test_rejects_negative_price():
    with pytest.raises(ValueError):
        Cart().add("pen", -1)
