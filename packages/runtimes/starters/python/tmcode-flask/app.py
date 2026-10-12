from flask import Flask, jsonify, request

app = Flask(__name__)
todos = [{"id": 1, "title": "Learn Flask", "done": False}]


@app.get("/api/todos")
def all_todos():
    return jsonify(todos)


@app.get("/api/todos/<int:todo_id>")
def one_todo(todo_id):
    todo = next((t for t in todos if t["id"] == todo_id), None)
    return (jsonify(todo), 200) if todo else (jsonify(error="Not found"), 404)


@app.post("/api/todos")
def create_todo():
    data = request.get_json(silent=True) or {}
    if not data.get("title"):
        return jsonify(error="title is required"), 400
    todo = {"id": len(todos) + 1, "title": data["title"], "done": False}
    todos.append(todo)
    return jsonify(todo), 201


@app.route("/")
def home():
    return "<h1>Flask is running</h1><p>Try <a href='/api/todos'>/api/todos</a></p>"


if __name__ == "__main__":
    app.run(debug=True)
