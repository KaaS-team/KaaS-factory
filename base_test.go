package tiny

import "testing"

func TestBase(t *testing.T) {
	if Base() != 1 {
		t.Fatal("Base")
	}
}
