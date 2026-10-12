package rw.ac.nga.demo;

import java.util.ArrayList;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/todos")
public class TodoController {
    public record Todo(int id, String title, boolean done) {}

    private final List<Todo> todos = new ArrayList<>(List.of(new Todo(1, "Learn Spring Boot", false)));

    @GetMapping
    public List<Todo> all() {
        return todos;
    }

    @GetMapping("/{id}")
    public ResponseEntity<Todo> one(@PathVariable int id) {
        return todos.stream().filter(t -> t.id() == id).findFirst().map(ResponseEntity::ok).orElse(ResponseEntity.notFound().build());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Todo create(@RequestBody Todo body) {
        Todo t = new Todo(todos.size() + 1, body.title(), false);
        todos.add(t);
        return t;
    }
}
