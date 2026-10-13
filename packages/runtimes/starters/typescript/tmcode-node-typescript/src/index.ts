interface Student {
  name: string;
  marks: number[];
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const students: Student[] = [
  { name: "Ada", marks: [90, 84, 77] },
  { name: "Ben", marks: [65, 72, 80] },
];

for (const s of students) {
  console.log(`${s.name}: ${average(s.marks).toFixed(1)}`);
}
