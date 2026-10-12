import { average, isPrime } from "./math.js";

const marks = [72, 85, 64];
console.log(`Average of ${marks.join(", ")}: ${average(marks).toFixed(2)}`);
console.log("Primes below 20:", [...Array(20).keys()].filter(isPrime).join(" "));
