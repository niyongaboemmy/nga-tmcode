class Cart:
    """A shopping cart: item name → (unit price, quantity)."""

    def __init__(self) -> None:
        self.items = {}

    def add(self, name: str, price: int, quantity: int = 1) -> None:
        if price < 0 or quantity <= 0:
            raise ValueError("price must be >= 0 and quantity > 0")
        _, old = self.items.get(name, (price, 0))
        self.items[name] = (price, old + quantity)

    def total(self) -> int:
        return sum(price * qty for price, qty in self.items.values())


if __name__ == "__main__":
    cart = Cart()
    cart.add("notebook", 500, 3)
    cart.add("pen", 200)
    print(f"Total: {cart.total()} RWF")
