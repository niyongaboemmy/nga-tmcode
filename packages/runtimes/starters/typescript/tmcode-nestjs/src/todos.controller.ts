import { Body, Controller, Get, Param, ParseIntPipe, Post } from "@nestjs/common";
import { TodosService } from "./todos.service";

@Controller("api/todos")
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Get()
  all() {
    return this.todos.all();
  }

  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return this.todos.one(id);
  }

  @Post()
  create(@Body() body: { title: string }) {
    return this.todos.create(body.title);
  }
}
