//go:build unix

package workspace

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes a non-blocking exclusive advisory lock on an already-open lock file. flock locks
// belong to the open file description, so two Barista processes, or two descriptors in one
// process, exclude each other.
func lockFile(file *os.File) error {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrLeaseOwned
	}
	return err
}

func unlockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}

const openLockFlags = os.O_CREATE | os.O_RDWR | syscall.O_NOFOLLOW
