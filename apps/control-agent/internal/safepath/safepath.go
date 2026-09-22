// Package safepath creates and verifies directories beneath a trusted root one path component at
// a time, refusing any symbolic link or non-directory at every level instead of following it.
package safepath

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// EnsureDirectoryWithinRoot walks from root down to directory one component at a time, using
// Lstat before ever trusting or creating a component: an existing symlink at any level is refused,
// never followed and never replaced, and a missing component is created with a plain Mkdir (which,
// unlike MkdirAll's Stat-based traversal, fails against anything already present rather than
// walking through it) using mode, then re-inspected with Lstat. root itself must be a real,
// non-symlinked directory, so a symlinked root can never pivot every containment check below it.
func EnsureDirectoryWithinRoot(root string, directory string, mode fs.FileMode) (string, error) {
	return walk(root, directory, func(current string) error {
		information, err := os.Lstat(current)
		switch {
		case err == nil:
			return RejectUnsafeAncestor(current, information)
		case errors.Is(err, fs.ErrNotExist):
			if mkdirErr := os.Mkdir(current, mode); mkdirErr != nil && !errors.Is(mkdirErr, fs.ErrExist) {
				return fmt.Errorf("create directory ancestor %s: %w", current, mkdirErr)
			}
			information, err := os.Lstat(current)
			if err != nil {
				return fmt.Errorf("inspect directory ancestor %s after creating it: %w", current, err)
			}
			return RejectUnsafeAncestor(current, information)
		default:
			return fmt.Errorf("inspect directory ancestor %s: %w", current, err)
		}
	})
}

// VerifyDirectoryWithinRoot performs the same symlink-refusing walk as EnsureDirectoryWithinRoot
// but never creates a missing component.
func VerifyDirectoryWithinRoot(root string, directory string) (string, error) {
	return walk(root, directory, func(current string) error {
		information, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("inspect directory ancestor %s: %w", current, err)
		}
		return RejectUnsafeAncestor(current, information)
	})
}

// RejectUnsafeAncestor refuses a symbolic link or anything that is not a directory.
func RejectUnsafeAncestor(current string, information fs.FileInfo) error {
	if information.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("directory ancestor %s is a symlink", current)
	}
	if !information.IsDir() {
		return fmt.Errorf("directory ancestor %s is not a directory", current)
	}
	return nil
}

func walk(root string, directory string, visit func(string) error) (string, error) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(directory) {
		return "", errors.New("root and target directory must be absolute paths")
	}
	cleanRoot := filepath.Clean(root)
	cleanDirectory := filepath.Clean(directory)
	if cleanDirectory != cleanRoot && !strings.HasPrefix(cleanDirectory, cleanRoot+string(filepath.Separator)) {
		return "", errors.New("target directory escapes the root")
	}
	rootInformation, err := os.Lstat(cleanRoot)
	if err != nil {
		return "", fmt.Errorf("inspect root: %w", err)
	}
	if err := RejectUnsafeAncestor(cleanRoot, rootInformation); err != nil {
		return "", err
	}
	relative := strings.TrimPrefix(strings.TrimPrefix(cleanDirectory, cleanRoot), string(filepath.Separator))
	current := cleanRoot
	if relative == "" {
		return current, nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." || component == ".." {
			return "", errors.New("target directory path is malformed")
		}
		current = filepath.Join(current, component)
		if err := visit(current); err != nil {
			return "", err
		}
	}
	return current, nil
}
