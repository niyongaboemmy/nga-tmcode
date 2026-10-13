package main

import (
	"fmt"

	"example.com/grades/internal/grades"
)

func main() {
	for _, mark := range []int{91, 74, 58, 33} {
		fmt.Printf("%d -> %s\n", mark, grades.Letter(mark))
	}
}
