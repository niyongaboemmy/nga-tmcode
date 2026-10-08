import { gitignore, ioTests, readme, type Template } from "./kit";

/** SQL and data analysis. */
export const DATA: Template[] = [
  {
    id: "sql",
    main: "queries.sql",
    label: "SQL (SQLite)",
    description: "Tables, data and queries that run inside TMCode, results as tables",
    icon: "database",
    language: "sql",
    category: "Data & SQL",
    files: {
      "schema.sql": `-- Tables. Fresh runs of queries.sql build these first.\nCREATE TABLE students (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  class TEXT NOT NULL\n);\n\nCREATE TABLE subjects (\n  id INTEGER PRIMARY KEY,\n  title TEXT NOT NULL UNIQUE\n);\n\nCREATE TABLE marks (\n  student_id INTEGER NOT NULL REFERENCES students(id),\n  subject_id INTEGER NOT NULL REFERENCES subjects(id),\n  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),\n  PRIMARY KEY (student_id, subject_id)\n);\n`,
      "seed.sql": `INSERT INTO students (name, class) VALUES\n  ('Ada', 'S4A'), ('Ben', 'S4A'), ('Chloe', 'S4B'), ('Dan', 'S4B');\n\nINSERT INTO subjects (title) VALUES ('Maths'), ('Physics'), ('Computer Science');\n\nINSERT INTO marks VALUES\n  (1, 1, 92), (1, 2, 81), (1, 3, 95),\n  (2, 1, 64), (2, 2, 70), (2, 3, 78),\n  (3, 1, 88), (3, 2, 90), (3, 3, 84),\n  (4, 1, 51), (4, 3, 67);\n`,
      "queries.sql": `-- ⌘/Ctrl+Shift+Enter runs the whole file; ⌘/Ctrl+Enter runs the query under the cursor.\n\n-- 1. Everyone, best average first\nSELECT s.name, s.class, ROUND(AVG(m.score), 1) AS average, COUNT(*) AS subjects\nFROM students s\nJOIN marks m ON m.student_id = s.id\nGROUP BY s.id\nORDER BY average DESC;\n\n-- 2. The top mark in each subject\nSELECT sub.title, st.name, m.score\nFROM marks m\nJOIN subjects sub ON sub.id = m.subject_id\nJOIN students st ON st.id = m.student_id\nWHERE m.score = (SELECT MAX(score) FROM marks WHERE subject_id = m.subject_id);\n\n-- 3. Who has no Physics mark? (LEFT JOIN … IS NULL)\nSELECT s.name\nFROM students s\nLEFT JOIN marks m ON m.student_id = s.id AND m.subject_id = (SELECT id FROM subjects WHERE title = 'Physics')\nWHERE m.student_id IS NULL;\n\n-- 4. Class averages with a window function\nSELECT DISTINCT s.class, ROUND(AVG(m.score) OVER (PARTITION BY s.class), 1) AS class_average\nFROM students s JOIN marks m ON m.student_id = s.id;\n`,
      "README.md": readme("SQL with SQLite", [
        "▶ on a `.sql` file runs it in TMCode's built-in SQLite: every statement's result shows as a table beside the code, errors at their line.",
        "",
        "- **Fresh each run** (default): a new database every time; `schema.sql` and `seed.sql` run first.",
        "- **Keep data**: tables and rows stay between runs (Reset empties it).",
        "- 💡 on a query shows how SQLite runs it (EXPLAIN QUERY PLAN).",
      ]),
    },
  },
  {
    id: "python-data",
    main: "analysis.py",
    label: "Python Data Analysis (pandas)",
    description: "Load a CSV, summarise it and draw a chart",
    icon: "graph",
    language: "python",
    category: "Data & SQL",
    tools: ["python"],
    setup: { command: "python -m pip install -r requirements.txt", note: "Installs pandas and matplotlib" },
    files: {
      "requirements.txt": "pandas>=2.2\nmatplotlib>=3.8\n",
      "marks.csv": "name,class,maths,physics,cs\nAda,S4A,92,81,95\nBen,S4A,64,70,78\nChloe,S4B,88,90,84\nDan,S4B,51,58,67\n",
      "analysis.py": `import pandas as pd\nimport matplotlib\n\nmatplotlib.use("Agg")  # draw to a file\nimport matplotlib.pyplot as plt\n\ndf = pd.read_csv("marks.csv")\ndf["average"] = df[["maths", "physics", "cs"]].mean(axis=1).round(1)\n\nprint(df.sort_values("average", ascending=False).to_string(index=False))\nprint()\nprint(df.groupby("class")["average"].mean().round(1))\n\nax = df.plot.bar(x="name", y=["maths", "physics", "cs"], figsize=(7, 4), title="Marks by subject")\nax.set_ylabel("score")\nplt.tight_layout()\nplt.savefig("chart.png")\nprint("\\nSaved chart.png: open it in the Explorer to see the chart.")\n`,
      ".gitignore": gitignore(["chart.png"]),
      "README.md": readme("Data analysis", ["▶ on `analysis.py` prints the tables and saves `chart.png` (TMCode previews images)."]),
    },
  },
];

const PY_ALGOS = `"""Classic algorithms. Run the tests in the Testing view (beaker), or ▶ and type input."""


def bubble_sort(a):
    a = list(a)
    for i in range(len(a)):
        swapped = False
        for j in range(len(a) - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
                swapped = True
        if not swapped:
            break
    return a


def binary_search(a, target):
    lo, hi = 0, len(a) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if a[mid] == target:
            return mid
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1


def gcd(a, b):
    while b:
        a, b = b, a % b
    return a


if __name__ == "__main__":
    # Input: a line of numbers, then a number to find.
    numbers = [int(x) for x in input().split()]
    target = int(input())
    ordered = bubble_sort(numbers)
    print("Sorted:", *ordered)
    print("Index of", target, "=", binary_search(ordered, target))
    print("GCD of first two:", gcd(numbers[0], numbers[1]))
`;

const CPP_ALGOS = `#include <iostream>
#include <vector>
#include <sstream>
#include <string>
using namespace std;

// Classic algorithms: sort, search, gcd. The Testing view (beaker) runs the input tests.
void insertionSort(vector<int>& a) {
    for (size_t i = 1; i < a.size(); i++) {
        int key = a[i];
        int j = (int)i - 1;
        while (j >= 0 && a[j] > key) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = key;
    }
}

int binarySearch(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

int main() {
    string line;
    getline(cin, line);
    istringstream in(line);
    vector<int> a;
    for (int x; in >> x;) a.push_back(x);
    int target;
    cin >> target;
    vector<int> sorted = a;
    insertionSort(sorted);
    cout << "Sorted:";
    for (int x : sorted) cout << ' ' << x;
    cout << "\\nIndex of " << target << " = " << binarySearch(sorted, target) << "\\n";
    cout << "GCD of first two: " << gcd(a[0], a[1]) << "\\n";
}
`;

const JAVA_ALGOS = `import java.util.*;

// Classic algorithms: merge sort, binary search, gcd. The Testing view (beaker) runs the input tests.
public class Main {
    static int[] mergeSort(int[] a) {
        if (a.length < 2) return a;
        int[] left = mergeSort(Arrays.copyOfRange(a, 0, a.length / 2));
        int[] right = mergeSort(Arrays.copyOfRange(a, a.length / 2, a.length));
        int[] out = new int[a.length];
        int i = 0, j = 0, k = 0;
        while (i < left.length && j < right.length) out[k++] = left[i] <= right[j] ? left[i++] : right[j++];
        while (i < left.length) out[k++] = left[i++];
        while (j < right.length) out[k++] = right[j++];
        return out;
    }

    static int binarySearch(int[] a, int target) {
        int lo = 0, hi = a.length - 1;
        while (lo <= hi) {
            int mid = (lo + hi) >>> 1;
            if (a[mid] == target) return mid;
            if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
        }
        return -1;
    }

    static int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int[] a = Arrays.stream(in.nextLine().trim().split("\\\\s+")).mapToInt(Integer::parseInt).toArray();
        int target = in.nextInt();
        int[] sorted = mergeSort(a);
        StringBuilder sb = new StringBuilder("Sorted:");
        for (int x : sorted) sb.append(' ').append(x);
        System.out.println(sb);
        System.out.println("Index of " + target + " = " + binarySearch(sorted, target));
        System.out.println("GCD of first two: " + gcd(a[0], a[1]));
    }
}
`;

const C_ALGOS = `#include <stdio.h>

/* Classic algorithms: selection sort, binary search, gcd. The Testing view (beaker) runs the input tests. */
void selection_sort(int a[], int n) {
    for (int i = 0; i < n - 1; i++) {
        int min = i;
        for (int j = i + 1; j < n; j++)
            if (a[j] < a[min]) min = j;
        int t = a[i];
        a[i] = a[min];
        a[min] = t;
    }
}

int binary_search(const int a[], int n, int target) {
    int lo = 0, hi = n - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
}

int gcd(int a, int b) { return b == 0 ? a : gcd(b, a % b); }

int main(void) {
    int n, a[100], b[100], target;
    scanf("%d", &n);
    for (int i = 0; i < n; i++) {
        scanf("%d", &a[i]);
        b[i] = a[i];
    }
    scanf("%d", &target);
    selection_sort(b, n);
    printf("Sorted:");
    for (int i = 0; i < n; i++) printf(" %d", b[i]);
    printf("\\nIndex of %d = %d\\n", target, binary_search(b, n, target));
    printf("GCD of first two: %d\\n", gcd(a[0], a[1]));
    return 0;
}
`;

const OUT = "Sorted: 3 7 12 18 25\nIndex of 18 = 3\nGCD of first two: 6\n";
const OUT2 = "Sorted: 1 2 3\nIndex of 5 = -1\nGCD of first two: 1\n";

/** Learning: algorithms with input/output tests, logic, problem solving. */
export const LEARNING: Template[] = [
  {
    id: "algorithms-python",
    label: "Algorithms (Python)",
    description: "Sorting, binary search and GCD with input/output tests",
    icon: "list-ordered",
    language: "python",
    category: "Learning",
    tools: ["python"],
    files: {
      "algorithms.py": PY_ALGOS,
      ".tmcode/tests.json": ioTests("algorithms.py", [["sorts and finds", "18 12 25 3 7\n18\n", OUT], ["missing value", "3 1 2\n5\n", OUT2]]),
      "README.md": readme("Algorithms in Python", ["The Testing view (beaker) runs the input/output tests; a red test shows the expected vs actual output.", "", "F5 debugs: put a breakpoint in `bubble_sort` and watch the list change step by step."]),
    },
  },
  {
    id: "algorithms-c",
    label: "Algorithms (C)",
    description: "Selection sort, binary search and GCD with tests",
    icon: "list-ordered",
    language: "c",
    category: "Learning",
    tools: ["cc"],
    files: {
      "algorithms.c": C_ALGOS,
      ".tmcode/tests.json": ioTests("algorithms.c", [["sorts and finds", "5\n18 12 25 3 7\n18\n", OUT], ["missing value", "3\n3 1 2\n5\n", OUT2]]),
      ".gitignore": gitignore(["algorithms", "*.dSYM/"]),
      "README.md": readme("Algorithms in C", ["Input: the count, the numbers, then the value to find. The Testing view runs the tests; F5 debugs."]),
    },
  },
  {
    id: "algorithms-cpp",
    label: "Algorithms (C++)",
    description: "Insertion sort, binary search and GCD with tests",
    icon: "list-ordered",
    language: "cpp",
    category: "Learning",
    tools: ["cxx"],
    files: {
      "algorithms.cpp": CPP_ALGOS,
      ".tmcode/tests.json": ioTests("algorithms.cpp", [["sorts and finds", "18 12 25 3 7\n18\n", OUT], ["missing value", "3 1 2\n5\n", OUT2]]),
      ".gitignore": gitignore(["algorithms"]),
      "README.md": readme("Algorithms in C++", ["The Testing view runs the tests; F5 debugs."]),
    },
  },
  {
    id: "algorithms-java",
    label: "Algorithms (Java)",
    description: "Merge sort, binary search and GCD with tests",
    icon: "list-ordered",
    language: "java",
    category: "Learning",
    tools: ["java"],
    files: {
      "Main.java": JAVA_ALGOS,
      ".tmcode/tests.json": ioTests("Main.java", [["sorts and finds", "18 12 25 3 7\n18\n", OUT], ["missing value", "3 1 2\n5\n", OUT2]]),
      "README.md": readme("Algorithms in Java", ["The Testing view runs the tests."]),
    },
  },
  {
    id: "logic",
    main: "laws.logic",
    label: "Logic & Truth Tables",
    description: "Logical expressions with truth tables, equivalences and normal forms",
    icon: "symbol-boolean",
    language: "plaintext",
    category: "Learning",
    files: {
      "laws.logic": `# Truth tables update as you type (▶ or "Show Truth Tables").\n# Operators: and & ∧  or | ∨  not ! ¬  xor ^ ⊕  -> →  <-> ↔  nand nor  constants 0 1 T F\n\n# De Morgan's laws: F and G have the same table\nF = not (A and B)\nG = not A or not B\n\n# Implication and its contrapositive (a tautology)\nI = (p -> q) <-> (not q -> not p)\n\n# Distributive law\nD1 = A and (B or C)\nD2 = (A and B) or (A and C)\n\n# A contradiction\nX = p and not p\n`,
      "circuit.logic": `# A half adder and a full adder\nSum = A xor B\nCarry = A and B\n\nFullSum = A xor B xor Cin\nFullCarry = (A and B) or (Cin and (A xor B))\n`,
      "README.md": readme("Logic", ["Open a `.logic` file and press ▶: each expression gets its truth table (with a column per step), whether it is a tautology, contradiction or contingency, its minterms, and its sum-of-products / product-of-sums forms.", "", "Expressions with the same table are listed as **equivalent**."]),
    },
  },
  {
    id: "problem-solving",
    main: "PROBLEM.md",
    label: "Problem Solving (Python)",
    description: "A problem statement, a solution file and tests to pass",
    icon: "lightbulb",
    language: "python",
    category: "Learning",
    tools: ["python"],
    files: {
      "PROBLEM.md": `# FizzBuzz, with a twist\n\nRead a number **n**. For every i from 1 to n print:\n\n- \`FizzBuzz\` if i is divisible by 3 and by 5\n- \`Fizz\` if i is divisible by 3\n- \`Buzz\` if i is divisible by 5\n- otherwise i itself\n\nPrint them on one line, separated by spaces.\n\n| Input | Output |\n|---|---|\n| 5 | 1 2 Fizz 4 Buzz |\n| 15 | 1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz |\n`,
      "solution.py": `n = int(input())\n\n# Write your solution here, then run the tests (beaker).\nprint(n)\n`,
      ".tmcode/tests.json": ioTests("solution.py", [["n = 5", "5\n", "1 2 Fizz 4 Buzz\n"], ["n = 15", "15\n", "1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz\n"], ["n = 1", "1\n", "1\n"]]),
      "README.md": readme("Problem solving", ["Read `PROBLEM.md` (⌘/Ctrl+K V previews it), write `solution.py`, then run the tests in the Testing view until they are all green."]),
    },
  },
];
