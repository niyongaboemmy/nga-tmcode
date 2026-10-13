type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.r ** 2;
    case "rect":
      return s.w * s.h;
  }
}

const shapes: Shape[] = [{ kind: "circle", r: 2 }, { kind: "rect", w: 3, h: 4 }];
console.table(shapes.map((s) => ({ ...s, area: area(s).toFixed(2) })));
