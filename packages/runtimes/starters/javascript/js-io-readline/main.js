const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
const numbers = [];

rl.on("line", (line) => {
  for (const word of line.split(/\s+/)) {
    if (word !== "") numbers.push(Number(word));
  }
});

rl.on("close", () => {
  if (numbers.length === 0) {
    console.log("No numbers");
    return;
  }
  console.log(`Biggest: ${Math.max(...numbers)}`);
  console.log(`Smallest: ${Math.min(...numbers)}`);
});
