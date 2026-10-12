package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"sync"
)

type Todo struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

var (
	mu    sync.Mutex
	todos = []Todo{{ID: 1, Title: "Learn Go", Done: false}}
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func main() {
	http.HandleFunc("GET /api/todos", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		writeJSON(w, 200, todos)
	})
	http.HandleFunc("GET /api/todos/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.Atoi(r.PathValue("id"))
		mu.Lock()
		defer mu.Unlock()
		for _, t := range todos {
			if t.ID == id {
				writeJSON(w, 200, t)
				return
			}
		}
		writeJSON(w, 404, map[string]string{"error": "Not found"})
	})
	http.HandleFunc("POST /api/todos", func(w http.ResponseWriter, r *http.Request) {
		var body Todo
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Title == "" {
			writeJSON(w, 400, map[string]string{"error": "title is required"})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		body.ID = len(todos) + 1
		todos = append(todos, body)
		writeJSON(w, 201, body)
	})
	log.Println("Server running on http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
