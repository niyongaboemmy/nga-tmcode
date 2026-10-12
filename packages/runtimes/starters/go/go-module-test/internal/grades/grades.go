// Package grades turns marks out of 100 into letter grades.
package grades

// Letter is A for 80+, B for 70+, C for 60+, D for 50+, otherwise F.
func Letter(mark int) string {
	switch {
	case mark >= 80:
		return "A"
	case mark >= 70:
		return "B"
	case mark >= 60:
		return "C"
	case mark >= 50:
		return "D"
	default:
		return "F"
	}
}
