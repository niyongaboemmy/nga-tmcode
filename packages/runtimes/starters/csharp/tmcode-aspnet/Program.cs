var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var todos = new List<Todo> { new(1, "Learn ASP.NET Core", false) };

app.MapGet("/api/todos", () => todos);
app.MapGet("/api/todos/{id:int}", (int id) => todos.FirstOrDefault(t => t.Id == id) is { } t ? Results.Ok(t) : Results.NotFound());
app.MapPost("/api/todos", (TodoIn body) =>
{
    var t = new Todo(todos.Count + 1, body.Title, false);
    todos.Add(t);
    return Results.Created($"/api/todos/{t.Id}", t);
});

app.Run("http://localhost:5000");

record Todo(int Id, string Title, bool Done);
record TodoIn(string Title);
