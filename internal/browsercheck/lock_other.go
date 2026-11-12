//go:build !unix

package browsercheck

import "os"

// tryLock cannot tell a live owner from a dead one here, so it reports the file as locked and nothing is swept.
func tryLock(*os.File) bool { return false }
