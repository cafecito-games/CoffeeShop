package harness

import (
	"fmt"
	"path/filepath"
)

func AuthorizeWorkspace(workspace string, roots []string) (string, error) {
	if !filepath.IsAbs(workspace) {
		return "", fmt.Errorf("workspace must be an absolute path")
	}
	actual, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", fmt.Errorf("resolve workspace: %w", err)
	}
	for _, root := range roots {
		canonicalRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		relative, err := filepath.Rel(canonicalRoot, actual)
		if err != nil {
			continue
		}
		if relative == "." || relative != ".." && !startsWithParent(relative) && !filepath.IsAbs(relative) {
			return actual, nil
		}
	}
	return "", fmt.Errorf("workspace %s is outside this Barista's allowed roots", actual)
}

func startsWithParent(path string) bool {
	separator := string(filepath.Separator)
	return len(path) > 3 && path[:3] == ".."+separator
}
