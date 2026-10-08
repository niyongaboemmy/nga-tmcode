import type { TestSuite } from "./frameworks";
import { parseCargo, parseDartJson, parseGoJson, parseJest, parseJUnit, parseRspec, parseSwift, parseTrx, parseUnittest, type TestResult } from "./parsers";

/** Results from the report (or the output, for tools that only print), workspace-relative.
 * `root` is the absolute folder the command ran in. Null = no usable report. */
export function parseRun(suite: TestSuite, reports: string[] | null, output: string, root: string): TestResult[] | null {
  let rs: TestResult[];
  switch (suite.report.kind) {
    case "junit":
    case "junit-dir":
      if (!reports?.length) return null;
      rs = reports.flatMap((r) => parseJUnit(r, root));
      break;
    case "trx":
      if (!reports?.length) return null;
      rs = parseTrx(reports[0], root);
      break;
    case "jest":
      if (!reports?.length) return null;
      rs = parseJest(reports[0], root);
      break;
    case "rspec":
      if (!reports?.length) return null;
      rs = parseRspec(reports[0], root);
      break;
    case "go":
      rs = parseGoJson(output, root);
      break;
    case "dart":
      rs = parseDartJson(output, root);
      break;
    case "cargo":
      rs = parseCargo(output, root);
      break;
    case "swift":
      rs = parseSwift(output, root);
      break;
    case "unittest":
      rs = parseUnittest(output, root);
      break;
    default:
      return null;
  }
  if (!rs.length && suite.report.kind !== "junit" && suite.report.kind !== "junit-dir") return null;
  // Reports name files relative to the folder the command ran in.
  return rs.map((r) => ({ ...r, file: r.file && !r.file.startsWith("/") && suite.dir && !r.file.startsWith(`${suite.dir}/`) ? `${suite.dir}/${r.file}` : r.file }));
}

