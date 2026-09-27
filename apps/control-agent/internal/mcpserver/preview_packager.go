package mcpserver

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
)

const previewPackagingDirectory = "preview-packaging"

var (
	errPreviewInvalidPath     = errors.New("preview source contains an invalid path")
	errPreviewEntrypoint      = errors.New("preview entrypoint is not a captured regular file")
	errPreviewUnsupportedType = errors.New("preview source contains an unsupported file type")
	errPreviewSymlink         = errors.New("preview source contains a symbolic link")
	errPreviewLimit           = errors.New("preview source exceeds a bundle limit")
	errPreviewRatio           = errors.New("preview bundle exceeds the expansion ratio")
	errPreviewSource          = errors.New("preview source is unavailable")
	errPreviewSourceRace      = errors.New("preview source changed during packaging")
	errPreviewScratch         = errors.New("preview packaging scratch is unavailable")
	errPreviewWrite           = errors.New("preview bundle could not be finalized")
)

var previewScratchNamePattern = regexp.MustCompile(`^preview-bundle-[0-9a-f]{32}\.tar\.gz$`)

type previewPackageRequest struct {
	Workspace    string
	RelativePath string
	Entrypoint   string
	DataRoot     string
}

// previewPackagerHooks are test seams around mutation and I/O boundaries. Production passes the
// zero value, so the package format and checks have one implementation rather than a test-only
// builder that could drift from the bytes sent to the hub.
type previewPackagerHooks struct {
	walkEntry            func(string) error
	afterWalk            func() error
	beforeCopy           func(string) error
	afterCopy            func(string) error
	beforeVerify         func() error
	wrapCompressedWriter func(io.Writer) io.Writer
	closeTar             func(*tar.Writer) error
	closeGzip            func(*gzip.Writer) error
	syncFile             func(*os.File) error
	closeFile            func(*os.File) error
}

type previewArchive struct {
	mu       sync.Mutex
	root     *os.Root
	rootPath string
	name     string
	info     os.FileInfo
	size     int64
	sha256   string
	cleaned  bool
}

func (archive *previewArchive) open() (*os.File, error) {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if archive.cleaned || archive.root == nil || archive.info == nil {
		return nil, errPreviewScratch
	}
	info, err := archive.root.Lstat(archive.name)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, archive.info) || info.Size() != archive.size {
		return nil, errPreviewScratch
	}
	file, err := archive.root.Open(archive.name)
	if err != nil {
		return nil, errPreviewScratch
	}
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(opened, archive.info) || opened.Size() != archive.size {
		_ = file.Close()
		return nil, errPreviewScratch
	}
	afterOpen, err := archive.root.Lstat(archive.name)
	if err != nil || afterOpen.Mode()&os.ModeSymlink != 0 || !afterOpen.Mode().IsRegular() ||
		!os.SameFile(afterOpen, opened) {
		_ = file.Close()
		return nil, errPreviewScratch
	}
	return file, nil
}

func (archive *previewArchive) cleanup() error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if archive.cleaned {
		return nil
	}
	if archive.root == nil {
		archive.cleaned = true
		return nil
	}
	removeErr := archive.root.Remove(archive.name)
	if errors.Is(removeErr, os.ErrNotExist) {
		removeErr = nil
	}
	closeErr := archive.root.Close()
	archive.root = nil
	archive.cleaned = true
	if removeErr != nil || closeErr != nil {
		return errPreviewScratch
	}
	return nil
}

func (archive *previewArchive) pathForTest() string {
	return filepath.Join(archive.rootPath, archive.name)
}

type previewEntryKind uint8

const (
	previewDirectoryEntry previewEntryKind = iota + 1
	previewRegularFileEntry
)

type previewInventoryEntry struct {
	path    string
	kind    previewEntryKind
	info    os.FileInfo
	size    int64
	modTime time.Time
	digest  string
}

type previewInventory struct {
	entries       []previewInventoryEntry
	files         []int
	expandedBytes int64
	rootInfo      os.FileInfo
}

type openedPreviewSource struct {
	root          *os.Root
	workspacePath string
	workspaceInfo os.FileInfo
	sourcePath    string
	sourceInfo    os.FileInfo
}

func buildPreviewArchive(
	ctx context.Context,
	request previewPackageRequest,
	hooks previewPackagerHooks,
) (bundle *previewArchive, returnedErr error) {
	if err := contextError(ctx); err != nil {
		return nil, err
	}
	if err := protocol.ValidatePreviewBundlePath(request.RelativePath, false); err != nil {
		return nil, errPreviewInvalidPath
	}
	if err := protocol.ValidatePreviewBundlePath(request.Entrypoint, true); err != nil {
		return nil, errPreviewInvalidPath
	}
	source, err := openPreviewSource(request.Workspace, request.RelativePath)
	if err != nil {
		return nil, err
	}
	defer source.root.Close()

	resolvedDataRoot, err := resolvePreviewDataRoot(request.DataRoot)
	if err != nil {
		return nil, errPreviewScratch
	}
	prospectiveScratch := filepath.Join(resolvedDataRoot, previewPackagingDirectory)
	if pathWithin(source.sourcePath, prospectiveScratch) {
		return nil, errPreviewScratch
	}

	inventory, err := walkPreviewInventory(ctx, source.root, hooks.walkEntry)
	if err != nil {
		return nil, err
	}
	if !inventoryHasRegularFile(inventory, request.Entrypoint) {
		return nil, errPreviewEntrypoint
	}
	if hooks.afterWalk != nil {
		if err := hooks.afterWalk(); err != nil {
			return nil, errPreviewSourceRace
		}
	}

	scratchRoot, scratchPath, err := openPreviewScratch(resolvedDataRoot, true, false)
	if err != nil {
		return nil, err
	}
	file, bundle, err := createPreviewScratchFile(scratchRoot, scratchPath)
	if err != nil {
		_ = scratchRoot.Close()
		return nil, err
	}
	defer func() {
		if returnedErr != nil && bundle != nil {
			if cleanupErr := bundle.cleanup(); cleanupErr != nil {
				returnedErr = errPreviewScratch
			}
			bundle = nil
		}
	}()

	if err := writePreviewTarGzip(ctx, source.root, inventory, file, bundle, hooks); err != nil {
		return bundle, err
	}
	if err := validatePreviewCompression(inventory.expandedBytes, bundle.size); err != nil {
		return bundle, err
	}
	digest, err := digestPreviewArchive(ctx, bundle)
	if err != nil {
		return bundle, err
	}
	bundle.sha256 = digest

	if hooks.beforeVerify != nil {
		if err := hooks.beforeVerify(); err != nil {
			return bundle, errPreviewSourceRace
		}
	}
	verified, err := walkPreviewInventory(ctx, source.root, nil)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return bundle, err
		}
		return bundle, errPreviewSourceRace
	}
	if err := comparePreviewInventories(inventory, verified); err != nil {
		return bundle, err
	}
	if err := verifyPreviewContents(ctx, source.root, inventory); err != nil {
		return bundle, err
	}
	if err := verifyPreviewSourceIdentity(source, request.RelativePath); err != nil {
		return bundle, err
	}
	if err := contextError(ctx); err != nil {
		return bundle, err
	}
	return bundle, nil
}

func resolvePreviewDataRoot(dataRoot string) (string, error) {
	if dataRoot == "" || !filepath.IsAbs(dataRoot) {
		return "", errPreviewScratch
	}
	resolved, err := filepath.EvalSymlinks(dataRoot)
	if err != nil || !filepath.IsAbs(resolved) {
		return "", errPreviewScratch
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errPreviewScratch
	}
	return resolved, nil
}

func openPreviewSource(workspace, relativePath string) (*openedPreviewSource, error) {
	if workspace == "" || !filepath.IsAbs(workspace) {
		return nil, errPreviewSource
	}
	workspacePath, err := filepath.EvalSymlinks(workspace)
	if err != nil || !filepath.IsAbs(workspacePath) {
		return nil, errPreviewSource
	}
	workspaceRoot, err := os.OpenRoot(workspacePath)
	if err != nil {
		return nil, errPreviewSource
	}
	workspaceInfo, err := workspaceRoot.Lstat(".")
	if err != nil || !workspaceInfo.IsDir() {
		_ = workspaceRoot.Close()
		return nil, errPreviewSource
	}

	current := workspaceRoot
	currentOwned := false
	for _, component := range strings.Split(relativePath, "/") {
		info, err := current.Lstat(component)
		if err != nil {
			if currentOwned {
				_ = current.Close()
			}
			_ = workspaceRoot.Close()
			return nil, errPreviewSource
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if currentOwned {
				_ = current.Close()
			}
			_ = workspaceRoot.Close()
			return nil, errPreviewSymlink
		}
		if !info.IsDir() {
			if currentOwned {
				_ = current.Close()
			}
			_ = workspaceRoot.Close()
			return nil, errPreviewUnsupportedType
		}
		next, err := current.OpenRoot(component)
		if err != nil {
			if currentOwned {
				_ = current.Close()
			}
			_ = workspaceRoot.Close()
			return nil, errPreviewSourceRace
		}
		opened, err := next.Lstat(".")
		afterOpen, linkErr := current.Lstat(component)
		if err != nil || linkErr != nil || afterOpen.Mode()&os.ModeSymlink != 0 ||
			!opened.IsDir() || !afterOpen.IsDir() || !os.SameFile(info, opened) || !os.SameFile(afterOpen, opened) {
			_ = next.Close()
			if currentOwned {
				_ = current.Close()
			}
			_ = workspaceRoot.Close()
			return nil, errPreviewSourceRace
		}
		if currentOwned {
			_ = current.Close()
		}
		current = next
		currentOwned = true
	}
	if current == workspaceRoot {
		_ = workspaceRoot.Close()
		return nil, errPreviewInvalidPath
	}
	sourceInfo, err := current.Lstat(".")
	if err != nil || !sourceInfo.IsDir() {
		_ = current.Close()
		_ = workspaceRoot.Close()
		return nil, errPreviewSourceRace
	}
	_ = workspaceRoot.Close()
	return &openedPreviewSource{
		root: current, workspacePath: workspacePath, workspaceInfo: workspaceInfo,
		sourcePath: filepath.Join(workspacePath, filepath.FromSlash(relativePath)), sourceInfo: sourceInfo,
	}, nil
}

func verifyPreviewSourceIdentity(source *openedPreviewSource, relativePath string) error {
	reopened, err := openPreviewSource(source.workspacePath, relativePath)
	if err != nil {
		return errPreviewSourceRace
	}
	defer reopened.root.Close()
	if !os.SameFile(source.workspaceInfo, reopened.workspaceInfo) || !os.SameFile(source.sourceInfo, reopened.sourceInfo) {
		return errPreviewSourceRace
	}
	current, err := source.root.Lstat(".")
	if err != nil || !samePreviewSnapshot(source.sourceInfo, current) {
		return errPreviewSourceRace
	}
	return nil
}

func walkPreviewInventory(ctx context.Context, root *os.Root, visit func(string) error) (previewInventory, error) {
	rootInfo, err := root.Lstat(".")
	if err != nil || !rootInfo.IsDir() {
		return previewInventory{}, errPreviewSourceRace
	}
	inventory := previewInventory{rootInfo: rootInfo}
	collisions := map[string]string{}
	if err := walkPreviewDirectory(ctx, root, "", &inventory, collisions, visit); err != nil {
		return previewInventory{}, err
	}
	sort.Slice(inventory.entries, func(left, right int) bool {
		return inventory.entries[left].path < inventory.entries[right].path
	})
	inventory.files = inventory.files[:0]
	for index := range inventory.entries {
		if inventory.entries[index].kind == previewRegularFileEntry {
			inventory.files = append(inventory.files, index)
		}
	}
	return inventory, nil
}

func walkPreviewDirectory(
	ctx context.Context,
	root *os.Root,
	prefix string,
	inventory *previewInventory,
	collisions map[string]string,
	visit func(string) error,
) error {
	if err := contextError(ctx); err != nil {
		return err
	}
	directory, err := root.Open(".")
	if err != nil {
		return errPreviewSourceRace
	}
	defer directory.Close()
	for {
		entries, readErr := directory.ReadDir(128)
		for _, directoryEntry := range entries {
			if err := contextError(ctx); err != nil {
				return err
			}
			name := directoryEntry.Name()
			archivePath := name
			if prefix != "" {
				archivePath = prefix + "/" + name
			}
			if visit != nil {
				if err := visit(archivePath); err != nil {
					return errPreviewSourceRace
				}
				if err := contextError(ctx); err != nil {
					return err
				}
			}
			if err := protocol.ValidatePreviewBundlePath(archivePath, false); err != nil {
				return errPreviewInvalidPath
			}
			collisionKey := protocol.PreviewBundlePathCollisionKey(archivePath)
			if prior, exists := collisions[collisionKey]; exists && prior != archivePath {
				return errPreviewInvalidPath
			}
			if _, exists := collisions[collisionKey]; exists {
				return errPreviewInvalidPath
			}
			collisions[collisionKey] = archivePath

			info, err := root.Lstat(name)
			if err != nil {
				return errPreviewSourceRace
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return errPreviewSymlink
			}
			switch {
			case info.IsDir():
				inventory.entries = append(inventory.entries, previewInventoryEntry{
					path: archivePath, kind: previewDirectoryEntry, info: info, modTime: info.ModTime(),
				})
				child, err := root.OpenRoot(name)
				if err != nil {
					return errPreviewSourceRace
				}
				opened, statErr := child.Lstat(".")
				afterOpen, linkErr := root.Lstat(name)
				if statErr != nil || linkErr != nil || afterOpen.Mode()&os.ModeSymlink != 0 ||
					!opened.IsDir() || !afterOpen.IsDir() || !os.SameFile(info, opened) || !os.SameFile(afterOpen, opened) {
					_ = child.Close()
					return errPreviewSourceRace
				}
				walkErr := walkPreviewDirectory(ctx, child, archivePath, inventory, collisions, visit)
				closeErr := child.Close()
				if walkErr != nil {
					return walkErr
				}
				if closeErr != nil {
					return errPreviewSourceRace
				}
			case info.Mode().IsRegular():
				if err := validatePreviewFileSize(info.Size()); err != nil {
					return err
				}
				inventory.expandedBytes += info.Size()
				inventory.entries = append(inventory.entries, previewInventoryEntry{
					path: archivePath, kind: previewRegularFileEntry, info: info, size: info.Size(), modTime: info.ModTime(),
				})
				if err := validatePreviewInventoryLimits(countRegularFiles(inventory.entries), inventory.expandedBytes); err != nil {
					return err
				}
			default:
				return errPreviewUnsupportedType
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return errPreviewSourceRace
		}
	}
	return nil
}

func inventoryHasRegularFile(inventory previewInventory, path string) bool {
	for _, entry := range inventory.entries {
		if entry.path == path && entry.kind == previewRegularFileEntry {
			return true
		}
	}
	return false
}

func countRegularFiles(entries []previewInventoryEntry) int {
	count := 0
	for _, entry := range entries {
		if entry.kind == previewRegularFileEntry {
			count++
		}
	}
	return count
}

func validatePreviewFileSize(size int64) error {
	if size < 0 || size > protocol.PreviewBundleContract.MaximumFileBytes {
		return errPreviewLimit
	}
	return nil
}

func validatePreviewInventoryLimits(files int, expanded int64) error {
	if files < 0 || files > protocol.PreviewBundleContract.MaximumRegularFiles ||
		expanded < 0 || expanded > protocol.PreviewBundleContract.MaximumExpandedBytes {
		return errPreviewLimit
	}
	return nil
}

func validatePreviewCompressedSize(size int64) error {
	if size <= 0 || size > protocol.PreviewBundleContract.MaximumCompressedBytes {
		return errPreviewLimit
	}
	return nil
}

func validatePreviewCompression(expanded, compressed int64) error {
	if err := validatePreviewCompressedSize(compressed); err != nil {
		return err
	}
	if expanded > compressed*protocol.PreviewBundleContract.MaximumExpansionRatio {
		return errPreviewRatio
	}
	return nil
}

func writePreviewTarGzip(
	ctx context.Context,
	root *os.Root,
	inventory previewInventory,
	file *os.File,
	bundle *previewArchive,
	hooks previewPackagerHooks,
) error {
	destination := io.Writer(file)
	if hooks.wrapCompressedWriter != nil {
		destination = hooks.wrapCompressedWriter(destination)
	}
	limited := &previewCompressedWriter{writer: destination, maximum: protocol.PreviewBundleContract.MaximumCompressedBytes}
	compressed, err := gzip.NewWriterLevel(limited, gzip.BestCompression)
	if err != nil {
		_ = file.Close()
		return errPreviewWrite
	}
	compressed.Header = gzip.Header{Name: "", Comment: "", ModTime: time.Time{}, OS: 255}
	archive := tar.NewWriter(compressed)

	var firstErr error
	for _, fileIndex := range inventory.files {
		entry := &inventory.entries[fileIndex]
		if hooks.beforeCopy != nil {
			if err := hooks.beforeCopy(entry.path); err != nil {
				firstErr = errPreviewSourceRace
				break
			}
		}
		if err := contextError(ctx); err != nil {
			firstErr = err
			break
		}
		header := &tar.Header{
			Name: entry.path, Mode: 0o644, Uid: 0, Gid: 0, Uname: "", Gname: "",
			Size: entry.size, Typeflag: tar.TypeReg, ModTime: time.Unix(0, 0), Format: tar.FormatUnknown,
		}
		if err := archive.WriteHeader(header); err != nil {
			firstErr = classifyPreviewWriteError(err)
			break
		}
		digest, err := copyStablePreviewFile(ctx, root, *entry, archive)
		if err != nil {
			firstErr = err
			break
		}
		entry.digest = digest
		if hooks.afterCopy != nil {
			if err := hooks.afterCopy(entry.path); err != nil {
				firstErr = errPreviewSourceRace
				break
			}
		}
	}

	closeTar := archive.Close
	if hooks.closeTar != nil {
		closeTar = func() error { return hooks.closeTar(archive) }
	}
	if err := closeTar(); err != nil && firstErr == nil {
		firstErr = classifyPreviewWriteError(err)
	}
	closeGzip := compressed.Close
	if hooks.closeGzip != nil {
		closeGzip = func() error { return hooks.closeGzip(compressed) }
	}
	if err := closeGzip(); err != nil && firstErr == nil {
		firstErr = classifyPreviewWriteError(err)
	}
	syncFile := file.Sync
	if hooks.syncFile != nil {
		syncFile = func() error { return hooks.syncFile(file) }
	}
	if err := syncFile(); err != nil && firstErr == nil {
		firstErr = errPreviewWrite
	}
	closeFile := file.Close
	if hooks.closeFile != nil {
		closeFile = func() error { return hooks.closeFile(file) }
	}
	if err := closeFile(); err != nil && firstErr == nil {
		firstErr = errPreviewWrite
	}
	if firstErr != nil {
		return firstErr
	}

	info, err := bundle.root.Lstat(bundle.name)
	if err != nil || !info.Mode().IsRegular() || !previewOwnerOnlyFile(info) {
		return errPreviewScratch
	}
	bundle.info = info
	bundle.size = info.Size()
	if limited.written != bundle.size {
		return errPreviewWrite
	}
	return validatePreviewCompressedSize(bundle.size)
}

type previewCompressedWriter struct {
	writer  io.Writer
	written int64
	maximum int64
}

func (writer *previewCompressedWriter) Write(data []byte) (int, error) {
	remaining := writer.maximum - writer.written
	if remaining <= 0 && len(data) > 0 {
		return 0, errPreviewLimit
	}
	if int64(len(data)) > remaining {
		written, err := writer.writer.Write(data[:remaining])
		writer.written += int64(written)
		if err != nil {
			return written, err
		}
		return written, errPreviewLimit
	}
	written, err := writer.writer.Write(data)
	writer.written += int64(written)
	return written, err
}

func classifyPreviewWriteError(err error) error {
	if errors.Is(err, errPreviewLimit) {
		return errPreviewLimit
	}
	return errPreviewWrite
}

func copyStablePreviewFile(
	ctx context.Context,
	root *os.Root,
	expected previewInventoryEntry,
	destination io.Writer,
) (string, error) {
	localPath := filepath.FromSlash(expected.path)
	before, err := root.Lstat(localPath)
	if err != nil || !samePreviewSnapshot(expected.info, before) {
		return "", errPreviewSourceRace
	}
	file, err := root.Open(localPath)
	if err != nil {
		return "", errPreviewSourceRace
	}
	opened, err := file.Stat()
	if err != nil || !samePreviewSnapshot(expected.info, opened) {
		_ = file.Close()
		return "", errPreviewSourceRace
	}
	afterOpen, err := root.Lstat(localPath)
	if err != nil || afterOpen.Mode()&os.ModeSymlink != 0 || !samePreviewSnapshot(opened, afterOpen) {
		_ = file.Close()
		return "", errPreviewSourceRace
	}
	hash := sha256.New()
	written, err := copyPreviewBytes(ctx, file, io.MultiWriter(destination, hash), expected.size)
	if err != nil {
		_ = file.Close()
		return "", err
	}
	if written != expected.size {
		_ = file.Close()
		return "", errPreviewSourceRace
	}
	after, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil || closeErr != nil || !samePreviewSnapshot(expected.info, after) {
		return "", errPreviewSourceRace
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func copyPreviewBytes(ctx context.Context, source io.Reader, destination io.Writer, size int64) (int64, error) {
	buffer := make([]byte, 32*1024)
	remaining := size
	var total int64
	for remaining > 0 {
		if err := contextError(ctx); err != nil {
			return total, err
		}
		amount := int64(len(buffer))
		if remaining < amount {
			amount = remaining
		}
		read, readErr := source.Read(buffer[:amount])
		if read > 0 {
			written, writeErr := destination.Write(buffer[:read])
			total += int64(written)
			remaining -= int64(written)
			if writeErr != nil || written != read {
				if writeErr != nil {
					return total, classifyPreviewWriteError(writeErr)
				}
				return total, errPreviewWrite
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && remaining == 0 {
				break
			}
			return total, errPreviewSourceRace
		}
		if read == 0 {
			return total, errPreviewSourceRace
		}
	}
	one := []byte{0}
	read, readErr := source.Read(one)
	if read != 0 || !errors.Is(readErr, io.EOF) {
		return total, errPreviewSourceRace
	}
	return total, nil
}

func samePreviewSnapshot(expected, actual os.FileInfo) bool {
	return expected != nil && actual != nil && expected.Mode().Type() == actual.Mode().Type() &&
		expected.Mode().IsRegular() == actual.Mode().IsRegular() && expected.IsDir() == actual.IsDir() &&
		os.SameFile(expected, actual) && expected.Size() == actual.Size() && expected.ModTime().Equal(actual.ModTime())
}

func comparePreviewInventories(expected, actual previewInventory) error {
	if !samePreviewSnapshot(expected.rootInfo, actual.rootInfo) ||
		len(expected.entries) != len(actual.entries) || expected.expandedBytes != actual.expandedBytes {
		return errPreviewSourceRace
	}
	for index := range expected.entries {
		left, right := expected.entries[index], actual.entries[index]
		if left.path != right.path || left.kind != right.kind || left.size != right.size ||
			!left.modTime.Equal(right.modTime) || !os.SameFile(left.info, right.info) {
			return errPreviewSourceRace
		}
	}
	return nil
}

func verifyPreviewContents(ctx context.Context, root *os.Root, inventory previewInventory) error {
	for _, fileIndex := range inventory.files {
		entry := inventory.entries[fileIndex]
		digest, err := copyStablePreviewFile(ctx, root, entry, io.Discard)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			return errPreviewSourceRace
		}
		if digest != entry.digest {
			return errPreviewSourceRace
		}
	}
	return nil
}

func digestPreviewArchive(ctx context.Context, bundle *previewArchive) (string, error) {
	file, err := bundle.open()
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := copyPreviewBytes(ctx, file, hash, bundle.size)
	closeErr := file.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil || written != bundle.size {
		return "", errPreviewScratch
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func createPreviewScratchFile(root *os.Root, rootPath string) (*os.File, *previewArchive, error) {
	for attempt := 0; attempt < 16; attempt++ {
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return nil, nil, errPreviewScratch
		}
		name := "preview-bundle-" + hex.EncodeToString(random) + ".tar.gz"
		file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, nil, errPreviewScratch
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || !previewOwnerOnlyFile(info) {
			_ = file.Close()
			_ = root.Remove(name)
			return nil, nil, errPreviewScratch
		}
		return file, &previewArchive{root: root, rootPath: rootPath, name: name}, nil
	}
	return nil, nil, errPreviewScratch
}

func openPreviewScratch(dataRoot string, create, recoverStale bool) (*os.Root, string, error) {
	resolved, err := resolvePreviewDataRoot(dataRoot)
	if err != nil {
		return nil, "", errPreviewScratch
	}
	data, err := os.OpenRoot(resolved)
	if err != nil {
		return nil, "", errPreviewScratch
	}
	info, err := data.Lstat(previewPackagingDirectory)
	if errors.Is(err, os.ErrNotExist) && create {
		if err := data.Mkdir(previewPackagingDirectory, 0o700); err != nil {
			_ = data.Close()
			return nil, "", errPreviewScratch
		}
		info, err = data.Lstat(previewPackagingDirectory)
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() || !previewOwnerOnlyDirectory(info) {
		_ = data.Close()
		return nil, "", errPreviewScratch
	}
	root, err := data.OpenRoot(previewPackagingDirectory)
	if err != nil {
		_ = data.Close()
		return nil, "", errPreviewScratch
	}
	opened, err := root.Lstat(".")
	afterOpen, linkErr := data.Lstat(previewPackagingDirectory)
	_ = data.Close()
	if err != nil || linkErr != nil || afterOpen.Mode()&os.ModeSymlink != 0 || !afterOpen.IsDir() ||
		!opened.IsDir() || !os.SameFile(info, opened) || !os.SameFile(afterOpen, opened) {
		_ = root.Close()
		return nil, "", errPreviewScratch
	}
	if err := inspectPreviewScratch(root, recoverStale); err != nil {
		_ = root.Close()
		return nil, "", err
	}
	return root, filepath.Join(resolved, previewPackagingDirectory), nil
}

func inspectPreviewScratch(root *os.Root, recoverStale bool) error {
	directory, err := root.Open(".")
	if err != nil {
		return errPreviewScratch
	}
	defer directory.Close()
	for {
		entries, readErr := directory.ReadDir(128)
		for _, entry := range entries {
			name := entry.Name()
			if !previewScratchNamePattern.MatchString(name) {
				return errPreviewScratch
			}
			info, err := root.Lstat(name)
			if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !previewOwnerOnlyFile(info) {
				return errPreviewScratch
			}
			if recoverStale {
				if err := root.Remove(name); err != nil {
					return errPreviewScratch
				}
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return errPreviewScratch
		}
	}
}

func recoverPreviewPackaging(dataRoot string) error {
	root, _, err := openPreviewScratch(dataRoot, true, true)
	if err != nil {
		return err
	}
	if err := root.Close(); err != nil {
		return errPreviewScratch
	}
	return nil
}

func previewOwnerOnlyDirectory(info os.FileInfo) bool {
	// Windows FileMode does not expose inherited ACLs as Unix permission bits. The dedicated child
	// inherits the operator-owned DataRoot ACL there; on Unix the exact owner-only mode is enforced.
	return runtime.GOOS == "windows" || info.Mode().Perm() == 0o700
}

func previewOwnerOnlyFile(info os.FileInfo) bool {
	return runtime.GOOS == "windows" || info.Mode().Perm() == 0o600
}

func pathWithin(parent, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func contextError(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
