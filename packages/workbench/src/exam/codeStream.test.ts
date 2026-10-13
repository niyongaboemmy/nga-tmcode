import { describe, expect, it } from "vitest";
import { ExamTaskSchema } from "@tmcode/protocol";
import { TmApi } from "./api";
import { examCodeTransport } from "../run/codeTransports";
import { sseParser, type SessionEvent } from "../run/codeRunner";

describe("exam code runner transport", () => {
  it("streams a live run's events through fetch, with the exam token, piece by piece", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const enc = new TextEncoder();
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const text = 'event: stdout\ndata: {"data":"é"}\n\nevent: exit\ndata: {"code":0,"verdict":"ok"}\n\n';
          const bytes = enc.encode(text);
          // Split inside the two-byte "é".
          const cut = text.indexOf("é") + 1;
          c.enqueue(bytes.slice(0, cut));
          c.enqueue(bytes.slice(cut));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    };
    const api = new TmApi("http://localhost:5147", fetchImpl);
    api.token = "tok";
    api.sid = "sid1";
    const t = examCodeTransport(api);
    const events: SessionEvent[] = [];
    const parse = sseParser((e) => events.push(e));
    await new Promise<void>((done) => t.stream("/sessions/r1/events", { data: parse, end: () => done() }));
    expect(seen).toEqual([{ url: "http://localhost:5147/api/tmcode/sessions/sid1/code/sessions/r1/events", auth: "Bearer tok" }]);
    expect(events).toEqual([{ type: "stdout", data: "é" }, expect.objectContaining({ type: "exit", code: 0 })]);
  });

  it("reports Task Mentor's `code` errors as code runner errors", async () => {
    const api = new TmApi("http://x", async () => new Response(JSON.stringify({ success: false, code: "NO_UNIT_TESTS", message: "none" }), { status: 422 }));
    api.sid = "s";
    await expect(examCodeTransport(api).call("POST", "/test", {})).rejects.toMatchObject({ status: 422, code: "NO_UNIT_TESTS" });
  });

  it("a task can say it is checked by unit tests", () => {
    const task = { question_id: 1, order: 1, points: 5, title: "t", brief_md: "", profile_id: "python-3", files: [], visible_tests: [], hidden_test_count: 0 };
    expect(ExamTaskSchema.parse(task).check_with).toBeUndefined();
    expect(ExamTaskSchema.parse({ ...task, check_with: "unit" }).check_with).toBe("unit");
    expect(ExamTaskSchema.safeParse({ ...task, check_with: "other" }).success).toBe(false);
  });
});
