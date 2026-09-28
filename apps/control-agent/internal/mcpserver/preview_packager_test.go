package mcpserver

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/protocol"
	"github.com/stretchr/testify/require"
)

type archivedFile struct {
	header tar.Header
	data   []byte
}

func previewFixture(t *testing.T) (string, string) {
	t.Helper()
	workspace := t.TempDir()
	site := filepath.Join(workspace, "site")
	require.NoError(t, os.MkdirAll(filepath.Join(site, "assets"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(site, "index.html"), []byte("<!doctype html><title>Preview</title>"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(site, "assets", "app.js"), []byte("console.log('preview');"), 0o600))
	return workspace, t.TempDir()
}

func packageFixture(t *testing.T, workspace, dataRoot string, hooks previewPackagerHooks) *previewArchive {
	t.Helper()
	bundle, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
	}, hooks)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, bundle.cleanup()) })
	return bundle
}

func archiveBytes(t *testing.T, bundle *previewArchive) []byte {
	t.Helper()
	file, err := bundle.open()
	require.NoError(t, err)
	data, err := io.ReadAll(file)
	require.NoError(t, err)
	require.NoError(t, file.Close())
	return data
}

func unpackPreview(t *testing.T, data []byte) []archivedFile {
	t.Helper()
	compressed, err := gzip.NewReader(bytes.NewReader(data))
	require.NoError(t, err)
	require.Empty(t, compressed.Name)
	require.Empty(t, compressed.Comment)
	require.True(t, compressed.ModTime.IsZero())
	require.Equal(t, byte(255), compressed.OS)
	reader := tar.NewReader(compressed)
	files := []archivedFile{}
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		require.NoError(t, err)
		data, err := io.ReadAll(reader)
		require.NoError(t, err)
		files = append(files, archivedFile{header: *header, data: data})
	}
	require.NoError(t, compressed.Close())
	return files
}

func TestPreviewArchiveIsDeterministicAndUsesPinnedMetadata(t *testing.T) {
	workspace, dataRoot := previewFixture(t)
	first := packageFixture(t, workspace, dataRoot, previewPackagerHooks{})
	firstBytes := archiveBytes(t, first)

	require.NoError(t, os.Chmod(filepath.Join(workspace, "site", "index.html"), 0o777))
	future := time.Date(2040, 1, 2, 3, 4, 5, 0, time.FixedZone("offset", 9*60*60))
	require.NoError(t, os.Chtimes(filepath.Join(workspace, "site", "index.html"), future, future))
	second := packageFixture(t, workspace, dataRoot, previewPackagerHooks{})
	require.Equal(t, firstBytes, archiveBytes(t, second))
	require.Equal(t, first.sha256, second.sha256)

	files := unpackPreview(t, firstBytes)
	require.Equal(t, []string{"assets/app.js", "index.html"}, []string{files[0].header.Name, files[1].header.Name})
	for _, file := range files {
		require.Equal(t, tar.FormatUSTAR, file.header.Format)
		require.Equal(t, int64(0o644), file.header.Mode)
		require.Zero(t, file.header.Uid)
		require.Zero(t, file.header.Gid)
		require.Empty(t, file.header.Uname)
		require.Empty(t, file.header.Gname)
		require.True(t, file.header.ModTime.Equal(time.Unix(0, 0)))
		require.Equal(t, byte(tar.TypeReg), file.header.Typeflag)
	}
}

func TestPreviewArchiveIgnoresFilesystemCreationOrder(t *testing.T) {
	build := func(t *testing.T, names []string) []byte {
		t.Helper()
		workspace := t.TempDir()
		require.NoError(t, os.Mkdir(filepath.Join(workspace, "site"), 0o755))
		for _, name := range names {
			require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", name), []byte(name), 0o600))
		}
		bundle, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: t.TempDir(),
		}, previewPackagerHooks{})
		require.NoError(t, err)
		defer bundle.cleanup()
		return archiveBytes(t, bundle)
	}
	forward := build(t, []string{"index.html", "z.js", "a.css"})
	reverse := build(t, []string{"a.css", "z.js", "index.html"})
	require.Equal(t, forward, reverse)
}

func TestPreviewArchiveSupportsAPathAtTheSharedPAXBound(t *testing.T) {
	workspace := t.TempDir()
	dataRoot := t.TempDir()
	path := strings.Repeat("a", 253) + "/" + strings.Repeat("b", 253) + "/" +
		strings.Repeat("c", 252) + "/" + strings.Repeat("d", 252) + "/index.html"
	require.Equal(t, protocol.PreviewBundleContract.MaximumPathBytes, len(path))
	full := filepath.Join(workspace, "site", filepath.FromSlash(path))
	require.NoError(t, os.MkdirAll(filepath.Dir(full), 0o755))
	require.NoError(t, os.WriteFile(full, []byte("pax"), 0o600))
	bundle, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: path, DataRoot: dataRoot,
	}, previewPackagerHooks{})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, bundle.cleanup()) })
	files := unpackPreview(t, archiveBytes(t, bundle))
	require.Len(t, files, 1)
	require.Equal(t, path, files[0].header.Name)
	require.Equal(t, tar.FormatPAX, files[0].header.Format)

	overPath := strings.Repeat("a", 253) + "/" + strings.Repeat("b", 253) + "/" +
		strings.Repeat("c", 252) + "/" + strings.Repeat("e", 253) + "/index.html"
	over := filepath.Join(workspace, "site", filepath.FromSlash(overPath))
	require.NoError(t, os.MkdirAll(filepath.Dir(over), 0o755))
	require.NoError(t, os.WriteFile(over, []byte("over"), 0o600))
	_, err = buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: path, DataRoot: dataRoot,
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewInvalidPath)
}

func TestPreviewSourceRejectsMissingEntrypointsAndUnsupportedEntries(t *testing.T) {
	workspace := t.TempDir()
	dataRoot := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(workspace, "site"), 0o755))
	for _, entrypoint := range []string{"index.html", "missing.html"} {
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: entrypoint, DataRoot: dataRoot,
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewEntrypoint, entrypoint)
	}
	require.NoError(t, os.Mkdir(filepath.Join(workspace, "site", "index.html"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "other.html"), []byte("other"), 0o600))
	_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewEntrypoint)
	require.NoError(t, os.RemoveAll(filepath.Join(workspace, "site", "index.html")))

	if runtime.GOOS != "windows" {
		require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "index.html"), []byte("ok"), 0o600))
		require.NoError(t, makeFIFO(filepath.Join(workspace, "site", "events")))
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewUnsupportedType)
	}
}

func TestPreviewSourceMustBeAnExistingNamedDirectory(t *testing.T) {
	workspace := t.TempDir()
	dataRoot := t.TempDir()
	_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "missing", Entrypoint: "index.html", DataRoot: dataRoot,
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewSource)
	require.NoError(t, os.WriteFile(filepath.Join(workspace, "file"), []byte("not a directory"), 0o600))
	_, err = buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "file", Entrypoint: "index.html", DataRoot: dataRoot,
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewUnsupportedType)
}

func TestPreviewSourceRejectsSymlinksAtEveryBoundary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink setup requires privileges on Windows")
	}
	outside := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(outside, "index.html"), []byte("outside"), 0o600))

	t.Run("requested directory", func(t *testing.T) {
		workspace := t.TempDir()
		require.NoError(t, os.Symlink(outside, filepath.Join(workspace, "site")))
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: t.TempDir(),
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewSymlink)
	})

	t.Run("requested component", func(t *testing.T) {
		workspace := t.TempDir()
		require.NoError(t, os.Mkdir(filepath.Join(workspace, "parent"), 0o755))
		require.NoError(t, os.Symlink(outside, filepath.Join(workspace, "parent", "site")))
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "parent/site", Entrypoint: "index.html", DataRoot: t.TempDir(),
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewSymlink)
	})

	t.Run("walked file", func(t *testing.T) {
		workspace, dataRoot := previewFixture(t)
		require.NoError(t, os.Symlink(filepath.Join(outside, "index.html"), filepath.Join(workspace, "site", "linked.html")))
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewSymlink)
	})
}

func TestPreviewSourceRejectsInvalidUnicodeAndCaseCollisions(t *testing.T) {
	for _, test := range []struct {
		name  string
		paths []string
	}{
		{name: "non NFC", paths: []string{"cafe\u0301.js"}},
		{name: "ASCII case collision", paths: []string{"App.js", "app.js"}},
		{name: "backslash", paths: []string{`bad\name.js`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := previewFixture(t)
			for _, name := range test.paths {
				require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", name), []byte("bad"), 0o600))
			}
			_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
				Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
			}, previewPackagerHooks{})
			require.ErrorIs(t, err, errPreviewInvalidPath)
		})
	}

	if runtime.GOOS != "windows" {
		workspace, dataRoot := previewFixture(t)
		invalid := string([]byte{'b', 'a', 'd', 0xff})
		require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", invalid), []byte("bad"), 0o600))
		_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewInvalidPath)
	}
}

func TestPreviewNumericLimitsAcceptTheBoundaryAndRejectOneOver(t *testing.T) {
	c := protocol.PreviewBundleContract
	require.NoError(t, validatePreviewInventoryLimits(c.MaximumRegularFiles, c.MaximumExpandedBytes))
	require.ErrorIs(t, validatePreviewInventoryLimits(c.MaximumRegularFiles+1, c.MaximumExpandedBytes), errPreviewLimit)
	require.ErrorIs(t, validatePreviewInventoryLimits(c.MaximumRegularFiles, c.MaximumExpandedBytes+1), errPreviewLimit)
	require.NoError(t, validatePreviewFileSize(c.MaximumFileBytes))
	require.ErrorIs(t, validatePreviewFileSize(c.MaximumFileBytes+1), errPreviewLimit)
	require.NoError(t, validatePreviewCompression(c.MaximumExpandedBytes, c.MaximumExpandedBytes/c.MaximumExpansionRatio))
	require.ErrorIs(t, validatePreviewCompression(c.MaximumExpandedBytes, c.MaximumExpandedBytes/c.MaximumExpansionRatio-1), errPreviewRatio)
	require.NoError(t, validatePreviewCompressedSize(c.MaximumCompressedBytes))
	require.ErrorIs(t, validatePreviewCompressedSize(c.MaximumCompressedBytes+1), errPreviewLimit)
}

func TestPreviewHighlyCompressibleTreeFailsTheExpansionRatio(t *testing.T) {
	workspace := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(workspace, "site"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(workspace, "site", "index.html"), bytes.Repeat([]byte("A"), 128*1024), 0o600))
	_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: t.TempDir(),
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewRatio)
}

func TestPreviewDetectsInventoryIdentityAndContentRaces(t *testing.T) {
	tests := []struct {
		name  string
		hooks func(string) previewPackagerHooks
	}{
		{name: "add", hooks: func(workspace string) previewPackagerHooks {
			return previewPackagerHooks{afterWalk: func() error {
				return os.WriteFile(filepath.Join(workspace, "site", "late.js"), []byte("late"), 0o600)
			}}
		}},
		{name: "remove", hooks: func(workspace string) previewPackagerHooks {
			return previewPackagerHooks{beforeVerify: func() error {
				return os.Remove(filepath.Join(workspace, "site", "assets", "app.js"))
			}}
		}},
		{name: "replace", hooks: func(workspace string) previewPackagerHooks {
			return previewPackagerHooks{beforeCopy: func(path string) error {
				if path != "index.html" {
					return nil
				}
				target := filepath.Join(workspace, "site", path)
				replacement := target + ".new"
				if err := os.WriteFile(replacement, []byte("replacement with another identity"), 0o600); err != nil {
					return err
				}
				return os.Rename(replacement, target)
			}}
		}},
		{name: "same size and restored mtime", hooks: func(workspace string) previewPackagerHooks {
			return previewPackagerHooks{afterCopy: func(path string) error {
				if path != "index.html" {
					return nil
				}
				target := filepath.Join(workspace, "site", path)
				info, err := os.Stat(target)
				if err != nil {
					return err
				}
				data, err := os.ReadFile(target)
				if err != nil {
					return err
				}
				for index := range data {
					data[index] ^= 1
				}
				if err := os.WriteFile(target, data, info.Mode()); err != nil {
					return err
				}
				return os.Chtimes(target, info.ModTime(), info.ModTime())
			}}
		}},
	}
	if runtime.GOOS != "windows" {
		tests = append(tests, struct {
			name  string
			hooks func(string) previewPackagerHooks
		}{name: "replace with symlink to the same identity", hooks: func(workspace string) previewPackagerHooks {
			return previewPackagerHooks{beforeCopy: func(path string) error {
				if path != "index.html" {
					return nil
				}
				target := filepath.Join(workspace, "site", path)
				saved := target + ".saved"
				if err := os.Rename(target, saved); err != nil {
					return err
				}
				return os.Symlink(filepath.Base(saved), target)
			}}
		}})
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := previewFixture(t)
			_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
				Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
			}, test.hooks(workspace))
			require.ErrorIs(t, err, errPreviewSourceRace)
			requireScratchEmpty(t, dataRoot)
		})
	}
}

func TestPreviewPackagingPropagatesWriterCloseSyncAndCancellationFailures(t *testing.T) {
	injected := errors.New("injected packaging failure")
	tests := []struct {
		name  string
		hooks func(context.CancelFunc) previewPackagerHooks
		want  error
	}{
		{name: "cancel during walk", hooks: func(cancel context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{walkEntry: func(string) error { cancel(); return nil }}
		}, want: context.Canceled},
		{name: "write", hooks: func(context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{wrapCompressedWriter: func(io.Writer) io.Writer { return failingWriter{err: injected} }}
		}, want: errPreviewWrite},
		{name: "tar close", hooks: func(context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{closeTar: func(writer *tar.Writer) error { _ = writer.Close(); return injected }}
		}, want: errPreviewWrite},
		{name: "gzip close", hooks: func(context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{closeGzip: func(writer *gzip.Writer) error { _ = writer.Close(); return injected }}
		}, want: errPreviewWrite},
		{name: "sync", hooks: func(context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{syncFile: func(*os.File) error { return injected }}
		}, want: errPreviewWrite},
		{name: "file close", hooks: func(context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{closeFile: func(file *os.File) error { _ = file.Close(); return injected }}
		}, want: errPreviewWrite},
		{name: "cancel during write", hooks: func(cancel context.CancelFunc) previewPackagerHooks {
			return previewPackagerHooks{beforeCopy: func(string) error { cancel(); return nil }}
		}, want: context.Canceled},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			workspace, dataRoot := previewFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, err := buildPreviewArchive(ctx, previewPackageRequest{
				Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: dataRoot,
			}, test.hooks(cancel))
			require.ErrorIs(t, err, test.want)
			requireScratchEmpty(t, dataRoot)
		})
	}
}

func TestPreviewScratchUsesOwnerOnlyPermissionsAndPreciseCleanup(t *testing.T) {
	workspace, dataRoot := previewFixture(t)
	unrelated := filepath.Join(dataRoot, "keep.txt")
	require.NoError(t, os.WriteFile(unrelated, []byte("keep"), 0o600))
	bundle := packageFixture(t, workspace, dataRoot, previewPackagerHooks{})
	rootInfo, err := os.Stat(filepath.Join(dataRoot, previewPackagingDirectory))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o700), rootInfo.Mode().Perm())
	fileInfo, err := os.Stat(bundle.pathForTest())
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), fileInfo.Mode().Perm())
	require.NoError(t, bundle.cleanup())
	_, err = os.Stat(bundle.pathForTest())
	require.ErrorIs(t, err, os.ErrNotExist)
	require.FileExists(t, unrelated)
}

func TestPreviewScratchRecoveryRemovesOnlyReservedRegularFiles(t *testing.T) {
	dataRoot := t.TempDir()
	directory := filepath.Join(dataRoot, previewPackagingDirectory)
	require.NoError(t, os.Mkdir(directory, 0o700))
	reserved := filepath.Join(directory, "preview-bundle-0123456789abcdef0123456789abcdef.tar.gz")
	require.NoError(t, os.WriteFile(reserved, []byte("stale"), 0o600))
	require.NoError(t, recoverPreviewPackaging(dataRoot))
	require.NoFileExists(t, reserved)

	unrelated := filepath.Join(directory, "do-not-delete")
	require.NoError(t, os.WriteFile(unrelated, []byte("owned by someone else"), 0o600))
	require.ErrorIs(t, recoverPreviewPackaging(dataRoot), errPreviewScratch)
	require.FileExists(t, unrelated)
	require.NoError(t, os.Remove(unrelated))

	if runtime.GOOS != "windows" {
		reservedWrongMode := filepath.Join(directory, "preview-bundle-abcdef0123456789abcdef0123456789.tar.gz")
		require.NoError(t, os.WriteFile(reservedWrongMode, []byte("not owned scratch"), 0o600))
		require.NoError(t, os.Chmod(reservedWrongMode, 0o644))
		require.ErrorIs(t, recoverPreviewPackaging(dataRoot), errPreviewScratch)
		require.FileExists(t, reservedWrongMode)
		require.NoError(t, os.Remove(reservedWrongMode))

		target := filepath.Join(dataRoot, "target")
		require.NoError(t, os.WriteFile(target, []byte("target"), 0o600))
		link := filepath.Join(directory, "preview-bundle-fedcba9876543210fedcba9876543210.tar.gz")
		require.NoError(t, os.Symlink(target, link))
		require.ErrorIs(t, recoverPreviewPackaging(dataRoot), errPreviewScratch)
		require.FileExists(t, target)
		_, err := os.Lstat(link)
		require.NoError(t, err)
	}
}

func TestPreviewScratchNeverFallsBackOrLivesInsideThePublishedTree(t *testing.T) {
	workspace, _ := previewFixture(t)
	_, err := buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: "index.html",
		DataRoot: filepath.Join(t.TempDir(), "missing"),
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewScratch)

	if runtime.GOOS != "windows" && os.Geteuid() != 0 {
		unwritable := t.TempDir()
		require.NoError(t, os.Chmod(unwritable, 0o500))
		t.Cleanup(func() { _ = os.Chmod(unwritable, 0o700) })
		_, err = buildPreviewArchive(context.Background(), previewPackageRequest{
			Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: unwritable,
		}, previewPackagerHooks{})
		require.ErrorIs(t, err, errPreviewScratch)
	}

	inside := filepath.Join(workspace, "site", "barista-data")
	require.NoError(t, os.Mkdir(inside, 0o700))
	_, err = buildPreviewArchive(context.Background(), previewPackageRequest{
		Workspace: workspace, RelativePath: "site", Entrypoint: "index.html", DataRoot: inside,
	}, previewPackagerHooks{})
	require.ErrorIs(t, err, errPreviewScratch)
}

type failingWriter struct{ err error }

func (writer failingWriter) Write([]byte) (int, error) { return 0, writer.err }

func requireScratchEmpty(t *testing.T, dataRoot string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dataRoot, previewPackagingDirectory))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	require.NoError(t, err)
	require.Empty(t, entries)
}
