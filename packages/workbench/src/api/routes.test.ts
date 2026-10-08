import { describe, expect, it } from "vitest";
import { exampleUrl, findRoutes } from "./routes";

const pick = (file: string, text: string) => findRoutes(file, text).map((r) => `${r.method} ${r.path}`);

describe("findRoutes", () => {
  it("Express", () => {
    expect(pick("server.js", "app.get('/api/todos', h);\nrouter.post(\"/api/todos\", h);\napp.delete(`/api/todos/:id`, h)")).toEqual(["GET /api/todos", "POST /api/todos", "DELETE /api/todos/:id"]);
  });
  it("NestJS", () => {
    expect(pick("cats.controller.ts", "@Controller('cats')\nclass C {\n@Get()\nall(){}\n@Get(':id')\none(){}\n@Post()\nmake(){}\n}")).toEqual(["GET /cats", "GET /cats/:id", "POST /cats"]);
  });
  it("Flask and FastAPI", () => {
    expect(pick("app.py", "@app.route('/')\ndef i(): pass\n@app.route('/items', methods=['GET', 'POST'])\ndef x(): pass")).toEqual(["GET /", "GET /items", "POST /items"]);
    expect(pick("main.py", "app = FastAPI()\n@app.get('/items/{item_id}')\ndef r(): pass")).toEqual(["GET /items/{item_id}"]);
  });
  it("Django urls", () => {
    expect(pick("urls.py", "urlpatterns = [\n  path('', views.home),\n  path('polls/<int:id>/', views.poll),\n]")).toEqual(["ANY /", "ANY /polls/<int:id>"]);
  });
  it("Spring", () => {
    expect(pick("HelloController.java", '@RestController\n@RequestMapping("/api")\nclass H {\n@GetMapping("/hello")\nString h(){}\n@PostMapping\nvoid p(){}\n}')).toEqual(["GET /api/hello", "POST /api"]);
  });
  it("Laravel, Go and Rails", () => {
    expect(pick("routes/api.php", "Route::get('/users', fn() => 1);")).toEqual(["GET /api/users"]);
    expect(pick("main.go", 'http.HandleFunc("/hello", h)\nhttp.HandleFunc("POST /items", h)\nr.GET("/ping", h)')).toEqual(["ANY /hello", "POST /items", "GET /ping"]);
    expect(pick("config/routes.rb", "Rails.application.routes.draw do\n  get 'articles', to: 'a#i'\nend")).toEqual(["GET /articles"]);
  });
  it("fills path parameters with an example", () => {
    expect(exampleUrl("/users/:id/posts/{post_id}/<int:n>")).toBe("/users/1/posts/1/1");
  });
});
