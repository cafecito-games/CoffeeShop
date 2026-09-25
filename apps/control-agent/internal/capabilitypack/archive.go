package capabilitypack

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The deterministic archive format. Every one of these values is pinned so that the same pack tree
// produces byte-identical archive bytes on any machine, in any locale, at any time, with any
// filesystem iteration order:
//
//   - entries are written in sorted path order, never in map or directory order;
//   - no directory entries are written at all, so no directory metadata can vary;
//   - mode is one fixed value, and uid, gid, uname, and gname are all zero or empty, so the building
//     account never leaks into the bytes;
//   - modification time is the Unix epoch, so no timestamp is recorded;
//   - the header format is USTAR, which carries no PAX extension records (PAX would embed
//     producer-dependent keys), and the packaged-path grammar bounds every name to fit it;
//   - the gzip header carries no original file name, no comment, a zero modification time, and the
//     "unknown" OS byte.
//
// The reader enforces every one of these that survives into the bytes — entry order, entry type, path
// grammar, mode, modification time, owner fields, USTAR framing, and all four gzip header fields — so
// an archive that was not produced this way is rejected rather than accepted as an equivalent pack.
// Only the absence of directory entries is implied rather than checked, because a directory entry is
// refused outright by the entry-type rule.
const (
	archiveEntryMode = 0o644
	// ArchiveMediaType is what the archive is; a manual distribution declares it as its executable
	// path's extension and nothing executes it.
	ArchiveMediaType = "application/gzip"
	// MaximumArchiveBytes bounds the compressed artifact. The expanded tree is bounded separately by
	// MaximumPackBytes, which is what actually guards against a compression bomb.
	MaximumArchiveBytes = 1 << 20
	// maximumExpandedArchiveBytes bounds the decompressed *tar stream*, which is the content bound
	// plus tar framing: one 512-byte header and up to 511 bytes of padding per entry, plus the
	// 1024-byte end-of-archive trailer. It must exceed MaximumPackBytes by at least that much, or a
	// tree the packer accepts at the content bound would build successfully and then fail every later
	// read — a pack that installs but can never activate. The real guard against an oversized or
	// compression-bombed archive is the running content total below, not this framing headroom.
	maximumExpandedArchiveBytes = MaximumPackBytes + MaximumPackFiles*1024 + 1024
)

var archiveEntryModTime = time.Unix(0, 0).UTC()

// gzipUnknownOS is the gzip "unknown operating system" byte. It is written and required on read, so
// the building host's operating system never appears in the archive bytes.
const gzipUnknownOS = 255

// BuildArchive validates tree and returns the deterministic archive bytes for it. A pack that does
// not validate produces no archive at all: there is no "build anyway" path, because the activation
// probe re-runs exactly this validation on the installed bytes and an archive that could not pass it
// could never be activated.
func BuildArchive(tree Tree, vocabulary Vocabulary) ([]byte, PackManifest, error) {
	manifest, err := Validate(tree, vocabulary)
	if err != nil {
		return nil, PackManifest{}, err
	}
	var buffer bytes.Buffer
	gzipWriter, err := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
	if err != nil {
		return nil, PackManifest{}, fmt.Errorf("create pack archive writer: %w", err)
	}
	gzipWriter.Name = ""
	gzipWriter.Comment = ""
	gzipWriter.ModTime = time.Time{}
	gzipWriter.OS = gzipUnknownOS // so the building operating system never appears in the bytes
	tarWriter := tar.NewWriter(gzipWriter)
	for _, path := range tree.Paths() {
		content := tree[path]
		header := &tar.Header{
			Typeflag: tar.TypeReg,
			Name:     path,
			Size:     int64(len(content)),
			Mode:     archiveEntryMode,
			ModTime:  archiveEntryModTime,
			Format:   tar.FormatUSTAR,
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return nil, PackManifest{}, fmt.Errorf("write pack archive header for %s: %w", path, err)
		}
		if _, err := tarWriter.Write(content); err != nil {
			return nil, PackManifest{}, fmt.Errorf("write pack archive entry for %s: %w", path, err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		return nil, PackManifest{}, fmt.Errorf("close pack archive: %w", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, PackManifest{}, fmt.Errorf("close pack archive: %w", err)
	}
	if buffer.Len() > MaximumArchiveBytes {
		return nil, PackManifest{}, fmt.Errorf("pack archive exceeds %d bytes", MaximumArchiveBytes)
	}
	return buffer.Bytes(), manifest, nil
}

// ArchiveTree expands archive bytes back into a tree, enforcing every determinism and containment
// rule the writer applies. Anything else — a path outside the grammar, a directory or symlink entry,
// a non-epoch timestamp, a different mode, a recorded owner, out-of-order entries, a duplicate name,
// or more bytes than the bounds allow — is a rejection. An archive nobody could have produced
// deterministically is not silently normalized into one that looks like it was.
func ArchiveTree(data []byte) (Tree, error) {
	if len(data) == 0 {
		return nil, errNoPackManifest
	}
	if len(data) > MaximumArchiveBytes {
		return nil, fmt.Errorf("pack archive exceeds %d bytes", MaximumArchiveBytes)
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("read pack archive: %s", screenDetail(err.Error()))
	}
	defer gzipReader.Close()
	// The gzip header is producer state too: a recorded original file name, a comment, a real
	// modification time, or a named operating system all vary per machine, so an archive carrying any
	// of them was not produced deterministically and is refused rather than normalized.
	if gzipReader.Name != "" || gzipReader.Comment != "" || !gzipReader.ModTime.IsZero() || gzipReader.OS != gzipUnknownOS {
		return nil, errors.New("pack archive gzip header does not carry the normalized metadata a deterministic pack archive has")
	}
	tarReader := tar.NewReader(io.LimitReader(gzipReader, maximumExpandedArchiveBytes+1))
	tree := Tree{}
	total := 0
	previous := ""
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read pack archive entry: %s", screenDetail(err.Error()))
		}
		if len(tree) >= MaximumPackFiles {
			return nil, fmt.Errorf("pack archive carries more than %d entries", MaximumPackFiles)
		}
		if header.Typeflag != tar.TypeReg {
			return nil, errors.New("pack archive carries an entry that is not a regular file")
		}
		if err := validatePackPath(header.Name); err != nil {
			return nil, fmt.Errorf("pack archive carries an unsafe entry path: %w", err)
		}
		if header.Mode != archiveEntryMode || header.ModTime.Unix() != 0 ||
			header.Uid != 0 || header.Gid != 0 || header.Uname != "" || header.Gname != "" {
			return nil, fmt.Errorf("pack archive entry %s does not carry the normalized metadata a deterministic pack archive has", header.Name)
		}
		// Format is a set of the formats the header could be read as. USTAR must be among them: a
		// GNU-only or PAX-only header carries extension records this packer never writes, and those
		// records are exactly where producer state would hide.
		if header.Format&tar.FormatUSTAR == 0 {
			return nil, fmt.Errorf("pack archive entry %s is not a USTAR header, so it may carry extension records", header.Name)
		}
		if header.Name <= previous {
			return nil, fmt.Errorf("pack archive entry %s is out of sorted order or duplicated", header.Name)
		}
		previous = header.Name
		if header.Size > MaximumFileBytes {
			return nil, fmt.Errorf("pack archive entry %s exceeds %d bytes", header.Name, MaximumFileBytes)
		}
		content, err := io.ReadAll(io.LimitReader(tarReader, MaximumFileBytes+1))
		if err != nil {
			return nil, fmt.Errorf("read pack archive entry %s: %s", header.Name, screenDetail(err.Error()))
		}
		if int64(len(content)) != header.Size {
			return nil, fmt.Errorf("pack archive entry %s does not carry the byte count its header declares", header.Name)
		}
		total += len(content)
		if total > MaximumPackBytes {
			return nil, fmt.Errorf("pack archive expands past %d bytes", MaximumPackBytes)
		}
		tree[header.Name] = content
	}
	if len(tree) == 0 {
		return nil, errNoPackManifest
	}
	return tree, nil
}

// ValidateArchive is the consumer-side entry point: expand the archive and run the one validator over
// it. It is what the activation probe calls, so the installed bytes are held to exactly the rules the
// packer held the source tree to.
func ValidateArchive(data []byte, vocabulary Vocabulary) (PackManifest, error) {
	tree, err := ArchiveTree(data)
	if err != nil {
		return PackManifest{}, err
	}
	return Validate(tree, vocabulary)
}

// ProbeInstalledArtifact is the activation probe for an installed capability pack: read the installed
// file, validate it through the one validator, and confirm it is the exact pack identity and version
// the component manifest declared. It executes nothing — a pack is prose — so a pack that answers no
// version contract is still fully verified before its selection becomes durable.
//
// The identity cross-check matters as much as the validation: without it a well-formed pack of some
// other version could be installed at a declared version's path and recorded as that version.
func ProbeInstalledArtifact(path string, componentID string, componentVersion string) (PackManifest, error) {
	information, err := os.Lstat(path)
	if err != nil {
		return PackManifest{}, fmt.Errorf("inspect capability pack artifact: %w", err)
	}
	if !information.Mode().IsRegular() {
		return PackManifest{}, errors.New("capability pack artifact is not a regular file")
	}
	if information.Size() > MaximumArchiveBytes {
		return PackManifest{}, fmt.Errorf("capability pack artifact exceeds %d bytes", MaximumArchiveBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return PackManifest{}, fmt.Errorf("read capability pack artifact: %w", err)
	}
	manifest, err := ValidateArchive(data, DefaultVocabulary())
	if err != nil {
		return PackManifest{}, err
	}
	if manifest.ID != componentID {
		return PackManifest{}, errors.New("the capability pack declares a different pack id than the component manifest entry")
	}
	if manifest.Version != componentVersion {
		return PackManifest{}, errors.New("the capability pack declares a different pack version than the component manifest entry")
	}
	return manifest, nil
}

// ArchiveDigest is the SHA-256 of archive bytes, the value a determinism check compares across two
// builds and the value an operator asserts at apply time for a manual distribution.
func ArchiveDigest(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// ReadTree reads a pack tree from a directory. It refuses anything that is not a regular file or a
// directory — a symlink is never followed, because the packaged bytes must be exactly the reviewed
// repository content and nothing a link could point at.
func ReadTree(root string) (Tree, error) {
	tree := Tree{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("pack source carries an entry that is not a regular file or directory")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		slashed := filepath.ToSlash(relative)
		if err := validatePackPath(slashed); err != nil {
			return fmt.Errorf("pack source carries an unsafe path: %w", err)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		tree[slashed] = content
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(tree) == 0 {
		return nil, errNoPackManifest
	}
	return tree, nil
}

// WriteFileInTree writes one pack file back into the source directory, used only by sealing. It
// refuses a path outside the packaged-path grammar, so sealing can never write outside the pack root.
func WriteFileInTree(root string, path string, content []byte) error {
	if err := validatePackPath(path); err != nil {
		return err
	}
	target := filepath.Join(root, filepath.FromSlash(path))
	if !strings.HasPrefix(target, filepath.Clean(root)+string(filepath.Separator)) {
		return errors.New("pack file path escapes the pack root")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, content, 0o644)
}
