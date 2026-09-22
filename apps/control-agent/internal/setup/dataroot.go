package setup

import (
	"os"
	"path/filepath"
)

// DefaultDataRoot is the Barista-owned data root used when no --data-root is given: the operating
// system's per-user configuration directory (falling back to the home directory when it cannot be
// determined) plus a coffee-shop/barista subdirectory. The data root is never $HOME itself, so
// every artifact this tool owns lives under one deletable prefix.
func DefaultDataRoot() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	return filepath.Join(base, "coffee-shop", "barista")
}
