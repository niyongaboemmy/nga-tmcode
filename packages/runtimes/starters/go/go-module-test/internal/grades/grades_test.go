package grades

import "testing"

func TestLetter(t *testing.T) {
	cases := []struct {
		mark int
		want string
	}{
		{95, "A"}, {80, "A"}, {79, "B"}, {60, "C"}, {50, "D"}, {12, "F"},
	}
	for _, c := range cases {
		if got := Letter(c.mark); got != c.want {
			t.Errorf("Letter(%d) = %q, want %q", c.mark, got, c.want)
		}
	}
}
