package rw.ac.nga.todo;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/todos")
public class TodoController {
    private final List<Todo> todos = new CopyOnWriteArrayList<>();
    private final AtomicLong nextId = new AtomicLong(1);

    @GetMapping
    public List<Todo> list() {
        return todos;
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody Map<String, String> body) {
        String title = body.getOrDefault("title", "").trim();
        if (title.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "title is required"));
        }
        Todo todo = new Todo(nextId.getAndIncrement(), title, false);
        todos.add(todo);
        return ResponseEntity.status(HttpStatus.CREATED).body(todo);
    }
}
