package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
)

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Split(bufio.ScanWords)
	sum, count, largest := 0, 0, 0
	for scanner.Scan() {
		n, err := strconv.Atoi(scanner.Text())
		if err != nil {
			continue
		}
		if count == 0 || n > largest {
			largest = n
		}
		sum += n
		count++
	}
	if count == 0 {
		fmt.Println("No numbers")
		return
	}
	fmt.Printf("Sum: %d\nLargest: %d\n", sum, largest)
}
