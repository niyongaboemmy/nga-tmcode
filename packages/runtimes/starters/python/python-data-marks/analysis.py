"""Marks per subject: the average, best and lowest mark, and a bar chart."""
from pathlib import Path

import pandas as pd

DATA = Path(__file__).parent / "data" / "marks.csv"


def load(path: Path = DATA) -> pd.DataFrame:
    return pd.read_csv(path)


def summary(marks: pd.DataFrame) -> pd.DataFrame:
    return marks.groupby("subject")["mark"].agg(average="mean", best="max", lowest="min").round(1)


def main() -> None:
    table = summary(load())
    print(table.to_string())
    import matplotlib

    matplotlib.use("Agg")
    ax = table["average"].plot.bar(title="Average mark per subject", rot=0)
    ax.set_ylabel("Mark")
    ax.figure.savefig("averages.png", bbox_inches="tight")
    print("Saved averages.png")


if __name__ == "__main__":
    main()
