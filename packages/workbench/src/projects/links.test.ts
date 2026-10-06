import { describe, expect, it } from "vitest";
import { parseProjectLink } from "./service";

describe("project deep links", () => {
  it("parses tmcode://project links", () => {
    expect(parseProjectLink("tmcode://project?id=12&api=https%3A%2F%2Ftaskmentor-api.amashuri.com")).toEqual({ id: 12, api: "https://taskmentor-api.amashuri.com" });
    expect(parseProjectLink("tmcode://project/?id=3&api=http://localhost:5002/")).toEqual({ id: 3, api: "http://localhost:5002" });
  });
  it("rejects other links", () => {
    expect(parseProjectLink("tmcode://launch?t=x&api=y")).toBeNull();
    expect(parseProjectLink("https://project?id=1&api=x")).toBeNull();
    expect(parseProjectLink("tmcode://project?id=abc&api=x")).toBeNull();
    expect(parseProjectLink("tmcode://project?id=-1&api=x")).toBeNull();
    expect(parseProjectLink("not a url")).toBeNull();
  });
});
