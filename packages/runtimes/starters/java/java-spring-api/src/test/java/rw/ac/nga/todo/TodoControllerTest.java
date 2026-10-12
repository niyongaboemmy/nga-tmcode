package rw.ac.nga.todo;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(TodoController.class)
class TodoControllerTest {
    @Autowired
    private MockMvc mvc;

    @Test
    void createsAndListsTodos() throws Exception {
        mvc.perform(post("/api/todos").contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Revise maths\"}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.title").value("Revise maths"));
        mvc.perform(get("/api/todos")).andExpect(status().isOk()).andExpect(jsonPath("$[0].done").value(false));
    }
}
