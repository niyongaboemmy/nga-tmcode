package main

import (
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

type Todo struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
	Done  bool   `json:"done"`
}

type store struct {
	mu    sync.Mutex
	todos []Todo
}

func newStore() *store { return &store{todos: []Todo{}} }

func newRouter(s *store) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.GET("/api/todos", func(c *gin.Context) {
		s.mu.Lock()
		defer s.mu.Unlock()
		c.JSON(http.StatusOK, s.todos)
	})
	r.POST("/api/todos", func(c *gin.Context) {
		var body struct {
			Title string `json:"title"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Title) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		todo := Todo{ID: len(s.todos) + 1, Title: strings.TrimSpace(body.Title)}
		s.todos = append(s.todos, todo)
		c.JSON(http.StatusCreated, todo)
	})
	return r
}
