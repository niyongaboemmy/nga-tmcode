import { Injectable, NotFoundException } from "@nestjs/common";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

@Injectable()
export class TodosService {
  private todos: Todo[] = [{ id: 1, title: "Learn NestJS", done: false }];

  all() {
    return this.todos;
  }

  one(id: number) {
    const t = this.todos.find((x) => x.id === id);
    if (!t) throw new NotFoundException("No such todo");
    return t;
  }

  create(title: string) {
    const t = { id: this.todos.length + 1, title, done: false };
    this.todos.push(t);
    return t;
  }
}
