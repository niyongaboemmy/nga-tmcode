package main

import "log"

func main() {
	r := newRouter(newStore())
	log.Println("To-do API on http://localhost:8080/api/todos")
	if err := r.Run(":8080"); err != nil {
		log.Fatal(err)
	}
}
