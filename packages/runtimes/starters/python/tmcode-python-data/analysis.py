import pandas as pd
import matplotlib

matplotlib.use("Agg")  # draw to a file
import matplotlib.pyplot as plt

df = pd.read_csv("marks.csv")
df["average"] = df[["maths", "physics", "cs"]].mean(axis=1).round(1)

print(df.sort_values("average", ascending=False).to_string(index=False))
print()
print(df.groupby("class")["average"].mean().round(1))

ax = df.plot.bar(x="name", y=["maths", "physics", "cs"], figsize=(7, 4), title="Marks by subject")
ax.set_ylabel("score")
plt.tight_layout()
plt.savefig("chart.png")
print("\nSaved chart.png: open it in the Explorer to see the chart.")
