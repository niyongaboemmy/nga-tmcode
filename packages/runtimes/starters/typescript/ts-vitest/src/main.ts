import { Stack } from "./stack.js";

const plates = new Stack<string>();
for (const colour of ["red", "green", "blue"]) plates.push(colour);
console.log(`Top plate: ${plates.peek()}, plates: ${plates.size}`);
console.log(`Took ${plates.pop()}, now ${plates.size} left`);
