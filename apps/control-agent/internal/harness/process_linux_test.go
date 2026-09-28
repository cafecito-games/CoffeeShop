//go:build linux

package harness

import (
	"go/parser"
	"go/token"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
)

func TestLinuxProviderParentDeathContract(t *testing.T) {
	command := exec.Command("provider-placeholder")
	configureProcessCancellation(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.Setpgid || command.SysProcAttr.Pdeathsig != syscall.SIGKILL {
		t.Fatalf("linux provider process attributes = %+v", command.SysProcAttr)
	}

	// Pdeathsig follows the creating OS thread. Keep Barista's own source free of cgo so a future
	// project-owned C/thread-affine launch cannot silently invalidate that lifetime assumption.
	root := filepath.Clean(filepath.Join("..", ".."))
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imported := range file.Imports {
			name, err := strconv.Unquote(imported.Path.Value)
			if err != nil {
				return err
			}
			if name == "C" {
				t.Errorf("project-owned cgo import invalidates the Linux Pdeathsig creator-thread assumption: %s", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
