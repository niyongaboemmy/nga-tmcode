// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locate, parseCargo, parseDartJson, parseGoJson, parseJest, parseJUnit, parseRspec, parseSwift, parseTrx, parseUnittest, summarize } from "./parsers";

/** Output captured from the real tools (paths rewritten to /ws). */
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const brief = (rs: { name: string; status: string; file: string | null; line: number | null }[]) => rs.map((r) => `${r.status} ${r.name} ${r.file ?? "-"}:${r.line ?? "-"}`);

describe("test report parsers (real output)", () => {
  it("pytest --junitxml", () => {
    const rs = parseJUnit(fx("pytest.xml"), "/ws");
    expect(brief(rs)).toEqual(["passed test_add -:-", "failed test_add_wrong test_calc.py:8", "passed test_ok -:-"]);
    expect(rs[1].message).toContain("assert 4 == 5");
    expect(rs[2].group).toBe("test_calc.TestMore");
    expect(summarize(rs)).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it("vitest junit: describe blocks become the group", () => {
    const rs = parseJUnit(fx("vitest.xml"), "/ws");
    expect(rs.map((r) => [r.group, r.name, r.status, r.file])).toEqual([
      ["src/calc.test.js › calc", "adds", "passed", "src/calc.test.js"],
      ["src/calc.test.js › calc", "fails", "failed", "src/calc.test.js"],
    ]);
    expect(rs[1].message).toBe("expected 2 to be 3 // Object.is equality");
  });

  it("node --test junit: the file attribute and the failing line", () => {
    const rs = parseJUnit(fx("node-test.xml"), "/ws");
    expect(brief(rs)).toEqual(["passed adds calc.test.mjs:-", "failed fails calc.test.mjs:4"]);
  });

  it("Maven Surefire and Gradle: the test class's own frame, not the assertion library's", () => {
    for (const fixture of ["surefire.xml", "gradle.xml"]) {
      const rs = parseJUnit(fx(fixture), "/ws");
      expect(brief(rs), fixture).toEqual(["passed adds -:-", "failed fails src/test/java/com/example/CalcTest.java:11"]);
      expect(rs[1].group).toBe("com.example.CalcTest");
      expect(rs[1].message).toContain("expected: <5> but was: <4>");
    }
  });

  it("PHPUnit --log-junit: the assertion, not the test's name, is the message", () => {
    const xml = `<testsuites><testsuite name="unit"><testcase name="test_fails" class="CalcTest" classname="CalcTest" file="/ws/tests/CalcTest.php" line="7" time="0.001"><failure type="PHPUnit\\Framework\\ExpectationFailedException">CalcTest::test_fails
Failed asserting that 4 is identical to 5.

/ws/tests/CalcTest.php:7</failure></testcase></testsuite></testsuites>`;
    const rs = parseJUnit(xml, "/ws");
    expect(brief(rs)).toEqual(["failed test_fails tests/CalcTest.php:7"]);
    expect(rs[0].message).toBe("Failed asserting that 4 is identical to 5.");
  });

  it("jest --json", () => {
    const rs = parseJest(fx("jest.json"), "/ws");
    expect(rs.map((r) => [r.group, r.name, r.status])).toEqual([
      ["j/calc.test.cjs › calc", "adds", "passed"],
      ["j/calc.test.cjs › calc", "fails", "failed"],
    ]);
    expect(rs[1].line).toBe(3);
    expect(rs[1].message).toContain("expect(received).toBe(expected)");
  });

  it("cargo test output", () => {
    const rs = parseCargo(fx("cargo.txt"), "/ws");
    expect(brief(rs)).toEqual(["passed adds -:-", "failed fails src/lib.rs:9"]);
    expect(rs[1].group).toBe("tests");
    expect(rs[1].message).toContain("assertion `left == right` failed");
  });

  it("dart test --reporter json (also flutter test --machine)", () => {
    const rs = parseDartJson(fx("dart.jsonl"), "/ws");
    expect(brief(rs)).toEqual(["passed calc adds test/calc_test.dart:4", "failed calc fails test/calc_test.dart:5"]);
    expect(rs[1].message).toBe("Expected: <3> ·   Actual: <2>");
  });

  it("swift test (XCTest) output", () => {
    const rs = parseSwift(fx("swift.txt"), "/ws");
    expect(brief(rs)).toEqual(["passed testAdds -:-", "failed testFails Tests/CalcTests/CalcTests.swift:5"]);
    expect(rs[1].group).toBe("CalcTests.CalcTests");
    expect(rs[1].message).toContain('XCTAssertEqual failed: ("4") is not equal to ("5")');
  });

  it("python -m unittest -v (and Django's test runner)", () => {
    const rs = parseUnittest(fx("unittest.txt"), "/ws");
    expect(brief(rs)).toEqual(["passed test_adds -:-", "error test_errors test_calc.py:14", "failed test_fails test_calc.py:11"]);
    expect(rs[2].message).toBe("AssertionError: 4 != 5");
  });

  it("python 3.11+ unittest names include the method", () => {
    const rs = parseUnittest("test_adds (test_calc.CalcTest.test_adds) ... ok\n", "/ws");
    expect(rs[0]).toMatchObject({ name: "test_adds", group: "test_calc.CalcTest", status: "passed" });
  });

  it("go test -json", () => {
    const jsonl = [
      { Action: "run", Package: "example.com/hello", Test: "TestGreet" },
      { Action: "output", Package: "example.com/hello", Test: "TestGreet", Output: "=== RUN   TestGreet\n" },
      { Action: "output", Package: "example.com/hello", Test: "TestGreet", Output: "    main_test.go:7: got \"Hi\"\n" },
      { Action: "output", Package: "example.com/hello", Test: "TestGreet", Output: "--- FAIL: TestGreet (0.00s)\n" },
      { Action: "fail", Package: "example.com/hello", Test: "TestGreet", Elapsed: 0.01 },
      { Action: "pass", Package: "example.com/hello", Test: "TestAdd", Elapsed: 0 },
      { Action: "fail", Package: "example.com/hello", Elapsed: 0.2 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const rs = parseGoJson(jsonl, "/ws");
    expect(brief(rs)).toEqual(["failed TestGreet main_test.go:7", "passed TestAdd -:-"]);
    expect(rs[0].message).toBe('got "Hi"');
  });

  it("rspec --format json", () => {
    const json = JSON.stringify({
      examples: [
        { description: "adds", full_description: "Calc adds", status: "passed", file_path: "./spec/calc_spec.rb", line_number: 3, run_time: 0.001 },
        { description: "fails", full_description: "Calc fails", status: "failed", file_path: "./spec/calc_spec.rb", line_number: 4, run_time: 0.002, exception: { class: "RSpec::Expectations::ExpectationNotMetError", message: "\nexpected: 5\n     got: 4", backtrace: ["./spec/calc_spec.rb:5:in `block (2 levels)'"] } },
      ],
    });
    const rs = parseRspec(json, "/ws");
    expect(brief(rs)).toEqual(["passed adds spec/calc_spec.rb:3", "failed fails spec/calc_spec.rb:5"]);
    expect(rs[1].group).toBe("spec/calc_spec.rb › Calc");
    expect(rs[1].message).toBe("expected: 5 · got: 4");
  });

  it(".NET TRX", () => {
    const trx = `<TestRun><Results>
      <UnitTestResult testName="Calc.Tests.CalcTests.Adds" outcome="Passed" duration="00:00:00.0040000" />
      <UnitTestResult testName="Calc.Tests.CalcTests.Fails" outcome="Failed" duration="00:00:00.0120000"><Output><ErrorInfo><Message>Assert.Equal() Failure&#xA;Expected: 5&#xA;Actual:   4</Message><StackTrace>   at Calc.Tests.CalcTests.Fails() in /ws/Tests/CalcTests.cs:line 12</StackTrace></ErrorInfo></Output></UnitTestResult>
    </Results></TestRun>`;
    const rs = parseTrx(trx, "/ws");
    expect(rs.map((r) => [r.group, r.name, r.status, r.durationMs])).toEqual([
      ["Calc.Tests.CalcTests", "Adds", "passed", 4],
      ["Calc.Tests.CalcTests", "Fails", "failed", 12],
    ]);
    expect(rs[1].message).toContain("Assert.Equal() Failure");
    expect([rs[1].file, rs[1].line]).toEqual(["Tests/CalcTests.cs", 12]);
  });

  it("locates the first workspace frame, preferring the test's own file", () => {
    expect(locate("at x (/usr/lib/node_modules/a.js:1:1)\nat y (/ws/src/b.test.js:9:3)", "/ws")).toEqual({ file: "src/b.test.js", line: 9 });
    expect(locate('File "/ws/a.py", line 3\nFile "/ws/b.py", line 7', "/ws", "b.py")).toEqual({ file: "b.py", line: 7 });
  });
});
