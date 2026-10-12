import express from "express";

/** The app without a port, so tests can call it directly. */
export function createApp() {
  const app = express();
  app.use(express.json());
  const todos = [];

  app.get("/api/todos", (_req, res) => res.json(todos));

  app.post("/api/todos", (req, res) => {
    const title = String(req.body?.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });
    const todo = { id: todos.length + 1, title, done: false };
    todos.push(todo);
    res.status(201).json(todo);
  });

  return app;
}
