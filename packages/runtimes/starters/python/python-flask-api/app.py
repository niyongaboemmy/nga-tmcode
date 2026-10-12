from flask import Flask, jsonify, request


def create_app() -> Flask:
    app = Flask(__name__)
    todos = []

    @app.get("/api/todos")
    def list_todos():
        return jsonify(todos)

    @app.post("/api/todos")
    def create_todo():
        title = (request.get_json(silent=True) or {}).get("title", "").strip()
        if not title:
            return jsonify(error="title is required"), 400
        todo = {"id": len(todos) + 1, "title": title, "done": False}
        todos.append(todo)
        return jsonify(todo), 201

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
