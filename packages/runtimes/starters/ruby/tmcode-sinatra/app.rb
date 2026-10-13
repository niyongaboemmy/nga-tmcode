require "sinatra"
require "json"

set :port, 4567
TODOS = [{ id: 1, title: "Learn Sinatra", done: false }]

get "/" do
  "<h1>Sinatra is running</h1><p>Try <a href='/api/todos'>/api/todos</a></p>"
end

get "/api/todos" do
  content_type :json
  TODOS.to_json
end

post "/api/todos" do
  content_type :json
  body = JSON.parse(request.body.read) rescue {}
  halt 400, { error: "title is required" }.to_json unless body["title"]
  todo = { id: TODOS.size + 1, title: body["title"], done: false }
  TODOS << todo
  status 201
  todo.to_json
end
