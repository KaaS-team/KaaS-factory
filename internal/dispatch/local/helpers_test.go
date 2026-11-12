package local

import (
	"strconv"
	"strings"
)

func itoa(i int) string           { return strconv.Itoa(i) }
func contains(s, sub string) bool { return strings.Contains(s, sub) }
