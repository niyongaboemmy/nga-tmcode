import express from "express";

const app = express();
app.use(express.json());

const todos = [{ id: 1, title: "Learn Express", done: false }];

app.get("/api/todos", (req, res) => res.json(todos));

app.get("/api/todos/:id", (req, res) => {
  const todo = todos.find((t) => t.id === Number(req.params.id));
  if (!todo) return res.status(404).json({ error: "Not found" });
  res.json(todo);
});

app.post("/api/todos", (req, res) => {
  if (!req.body?.title) return res.status(400).json({ error: "title is required" });
  const todo = { id: todos.length + 1, title: req.body.title, done: false };
  todos.push(todo);
  res.status(201).json(todo);
});

app.delete("/api/todos/:id", (req, res) => {
  const i = todos.findIndex((t) => t.id === Number(req.params.id));
  if (i < 0) return res.status(404).json({ error: "Not found" });
  todos.splice(i, 1);
  res.status(204).end();
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
