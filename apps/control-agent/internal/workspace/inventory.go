package workspace

import (
	"errors"
	"strings"
)

// Worktree is one record of `git worktree list --porcelain -z`, the authoritative local inventory.
type Worktree struct {
	Path     string
	Head     string
	Branch   string
	Bare     bool
	Detached bool
	Locked   bool
	Prunable bool
	// Unrecognized is set when Git reported an attribute this parser does not know; such a record
	// is never adopted or removed.
	Unrecognized bool
}

var errMalformedInventory = errors.New("worktree inventory is malformed")

// ParseWorktreeList parses NUL-terminated porcelain output byte for byte: attributes end in NUL
// and records end in an empty attribute, so paths containing newlines are represented exactly.
func ParseWorktreeList(output []byte) ([]Worktree, error) {
	text := string(output)
	if text == "" {
		return nil, nil
	}
	if !strings.HasSuffix(text, "\x00") {
		return nil, errMalformedInventory
	}
	var worktrees []Worktree
	var current *Worktree
	for _, attribute := range strings.Split(strings.TrimSuffix(text, "\x00"), "\x00") {
		if attribute == "" {
			if current == nil {
				return nil, errMalformedInventory
			}
			worktrees = append(worktrees, *current)
			current = nil
			continue
		}
		label, value, hasValue := strings.Cut(attribute, " ")
		if current == nil {
			if label != "worktree" || !hasValue || !strings.HasPrefix(value, "/") {
				return nil, errMalformedInventory
			}
			current = &Worktree{Path: value}
			continue
		}
		switch label {
		case "worktree":
			return nil, errMalformedInventory
		case "HEAD":
			current.Head = value
		case "branch":
			current.Branch = value
		case "bare":
			current.Bare = true
		case "detached":
			current.Detached = true
		case "locked":
			current.Locked = true
		case "prunable":
			current.Prunable = true
		default:
			current.Unrecognized = true
		}
	}
	if current != nil {
		worktrees = append(worktrees, *current)
	}
	return worktrees, nil
}

// StatusSummary classifies `git status --porcelain=v1 -z --ignored=matching` output.
type StatusSummary struct {
	Modified  int
	Untracked int
	Ignored   int
}

// ParseStatus counts tracked changes, untracked paths, and ignored paths. A rename or copy entry
// carries its source path as a second NUL-terminated field, which is skipped rather than counted.
func ParseStatus(output []byte) (StatusSummary, error) {
	var summary StatusSummary
	text := string(output)
	if text == "" {
		return summary, nil
	}
	if !strings.HasSuffix(text, "\x00") {
		return summary, errMalformedInventory
	}
	fields := strings.Split(strings.TrimSuffix(text, "\x00"), "\x00")
	for index := 0; index < len(fields); index++ {
		entry := fields[index]
		if len(entry) < 4 || entry[2] != ' ' {
			return StatusSummary{}, errMalformedInventory
		}
		code := entry[:2]
		switch {
		case code == "??":
			summary.Untracked++
		case code == "!!":
			summary.Ignored++
		default:
			summary.Modified++
			if strings.ContainsAny(code, "RC") {
				index++
				if index >= len(fields) {
					return StatusSummary{}, errMalformedInventory
				}
			}
		}
	}
	return summary, nil
}
