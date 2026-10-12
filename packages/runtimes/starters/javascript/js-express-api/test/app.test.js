import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("to-do API", () => {
  it("creates and lists todos", async () => {
    const app = createApp();
    const created = await request(app).post("/api/todos").send({ title: "Revise maths" });
    expect(created.status).toBe(201);
    const list = await request(app).get("/api/todos");
    expect(list.body).toEqual([{ id: 1, title: "Revise maths", done: false }]);
  });

  it("needs a title", async () => {
    const res = await request(createApp()).post("/api/todos").send({});
    expect(res.status).toBe(400);
  });
});
