//go:build unix

package browsercheck

import (
	"os"
	"syscall"
)

// tryLock takes a non-blocking exclusive lock on f; the OS drops it when the process dies, however it dies.
func tryLock(f *os.File) bool {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}
