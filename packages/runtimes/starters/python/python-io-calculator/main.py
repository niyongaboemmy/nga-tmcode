import sys


def calculate(a: float, op: str, b: float) -> str:
    """The result of `a op b` as text (whole numbers without ".0")."""
    if op == "+":
        result = a + b
    elif op == "-":
        result = a - b
    elif op == "*":
        result = a * b
    elif op == "/":
        if b == 0:
            return "Error: division by zero"
        result = a / b
    else:
        return f"Error: unknown operator {op}"
    return str(int(result)) if result == int(result) else str(round(result, 4))


def main() -> None:
    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 3:
            print("Error: write a calculation like 2 + 3")
            continue
        a, op, b = parts
        print(calculate(float(a), op, float(b)))


if __name__ == "__main__":
    main()
