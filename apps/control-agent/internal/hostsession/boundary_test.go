package hostsession_test

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCoreHasNoControlPlaneOrNetworkDependency(t *testing.T) {
	entries, err := os.ReadDir(".")
	require.NoError(t, err)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), filepath.Clean(entry.Name()), nil, parser.ImportsOnly)
		require.NoError(t, err)
		for _, imported := range file.Imports {
			path := strings.Trim(imported.Path.Value, "\"")
			require.NotContains(t, path, "/internal/controlplane", entry.Name())
			require.False(t, path == "net" || strings.HasPrefix(path, "net/"), entry.Name())
		}
	}
}
