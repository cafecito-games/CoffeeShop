//go:build !unix

package workspace

import (
	"errors"
	"os"
)

// Lease locks need flock; without it no lease can be owned, so no worktree is provisioned or cleaned.
func lockFile(*os.File) error {
	return errors.New("workspace lease locks are not supported on this platform")
}

func unlockFile(*os.File) error { return nil }

const openLockFlags = os.O_CREATE | os.O_RDWR
