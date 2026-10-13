package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateAndList(t *testing.T) {
	r := newRouter(newStore())

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/todos", strings.NewReader(`{"title":"Revise maths"}`)))
	if w.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want 201", w.Code)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/todos", nil))
	if want := `[{"id":1,"title":"Revise maths","done":false}]`; w.Body.String() != want {
		t.Fatalf("GET body = %s, want %s", w.Body.String(), want)
	}
}
