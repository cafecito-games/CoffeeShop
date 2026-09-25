// Command capabilitypack builds, seals, and validates the canonical Coffee Shop capability pack.
//
// It is a thin shell over internal/capabilitypack, which is the same package Barista's activation
// probe uses. That is deliberate: the bytes this command refuses to package are exactly the bytes a
// node would refuse to activate, so there is no way for a pack to build here and fail there.
//
// It reaches no network, reads no credential, and executes nothing it packages.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/capabilitypack"
)

const usage = `capabilitypack <command> [flags]

Commands:
  seal      regenerate the pack's derived files and per-file digests in place
  validate  validate a pack source tree without writing anything
  build     validate a pack source tree and write its deterministic archive
  verify    validate an already-built pack archive exactly as activation does
`

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	command, rest := args[0], args[1:]
	switch command {
	case "seal":
		return runSeal(rest)
	case "validate":
		return runValidate(rest)
	case "build":
		return runBuild(rest)
	case "verify":
		return runVerify(rest)
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "capabilitypack: unknown command\n%s", usage)
		return 2
	}
}

func packFlags(name string) (*flag.FlagSet, *string) {
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	source := set.String("pack", "capability-pack", "path to the capability pack source tree")
	return set, source
}

func parse(set *flag.FlagSet, args []string) (bool, int) {
	if err := set.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return false, 0
		}
		return false, 2
	}
	if set.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "%s: unexpected arguments\n", set.Name())
		return false, 2
	}
	return true, 0
}

func runValidate(args []string) int {
	set, source := packFlags("validate")
	if proceed, code := parse(set, args); !proceed {
		return code
	}
	tree, err := capabilitypack.ReadTree(*source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "validate: %v\n", err)
		return 1
	}
	manifest, err := capabilitypack.Validate(tree, capabilitypack.DefaultVocabulary())
	if err != nil {
		fmt.Fprintf(os.Stderr, "validate: %v\n", err)
		return 1
	}
	fmt.Printf("valid: %s with %d skills and %d files\n", manifest.Ref(), len(manifest.Skills), len(manifest.Files))
	return 0
}

func runSeal(args []string) int {
	set, source := packFlags("seal")
	check := set.Bool("check", false, "fail instead of writing when the tree is not already sealed")
	if proceed, code := parse(set, args); !proceed {
		return code
	}
	tree, err := capabilitypack.ReadTree(*source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal: %v\n", err)
		return 1
	}
	sealed, manifest, err := capabilitypack.Seal(tree, capabilitypack.DefaultVocabulary())
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal: %v\n", err)
		return 1
	}
	changed := make([]string, 0, len(sealed))
	for _, path := range sealed.Paths() {
		if existing, present := tree[path]; !present || string(existing) != string(sealed[path]) {
			changed = append(changed, path)
		}
	}
	if len(changed) == 0 {
		fmt.Printf("already sealed: %s\n", manifest.Ref())
		return 0
	}
	if *check {
		for _, path := range changed {
			fmt.Fprintf(os.Stderr, "seal: %s is not sealed\n", path)
		}
		return 1
	}
	for _, path := range changed {
		if err := capabilitypack.WriteFileInTree(*source, path, sealed[path]); err != nil {
			fmt.Fprintf(os.Stderr, "seal: write %s: %v\n", path, err)
			return 1
		}
		fmt.Printf("sealed: %s\n", path)
	}
	return 0
}

func runBuild(args []string) int {
	set, source := packFlags("build")
	out := set.String("out", "", "path of the deterministic pack archive to write (required)")
	if proceed, code := parse(set, args); !proceed {
		return code
	}
	if *out == "" {
		fmt.Fprintln(os.Stderr, "build: --out is required")
		return 2
	}
	tree, err := capabilitypack.ReadTree(*source)
	if err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n", err)
		return 1
	}
	archive, manifest, err := capabilitypack.BuildArchive(tree, capabilitypack.DefaultVocabulary())
	if err != nil {
		// A pack that does not validate produces no archive; any previously written one is left alone
		// rather than replaced with something unverified.
		fmt.Fprintf(os.Stderr, "build: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n", err)
		return 1
	}
	if err := os.WriteFile(*out, archive, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "build: %v\n", err)
		return 1
	}
	fmt.Printf("built: %s\n", manifest.Ref())
	fmt.Printf("archive: %s\n", *out)
	fmt.Printf("sha256: %s\n", capabilitypack.ArchiveDigest(archive))
	fmt.Printf("sizeBytes: %d\n", len(archive))
	return 0
}

func runVerify(args []string) int {
	set := flag.NewFlagSet("verify", flag.ContinueOnError)
	set.SetOutput(os.Stderr)
	archivePath := set.String("archive", "", "path of the pack archive to validate (required)")
	componentID := set.String("id", "", "pack id the component manifest declares (optional)")
	componentVersion := set.String("version", "", "pack version the component manifest declares (optional)")
	if proceed, code := parse(set, args); !proceed {
		return code
	}
	if *archivePath == "" {
		fmt.Fprintln(os.Stderr, "verify: --archive is required")
		return 2
	}
	if (*componentID == "") != (*componentVersion == "") {
		fmt.Fprintln(os.Stderr, "verify: --id and --version must be given together")
		return 2
	}
	if *componentID != "" {
		manifest, err := capabilitypack.ProbeInstalledArtifact(*archivePath, *componentID, *componentVersion)
		if err != nil {
			fmt.Fprintf(os.Stderr, "verify: %v\n", err)
			return 1
		}
		fmt.Printf("verified: %s\n", manifest.Ref())
		return 0
	}
	data, err := os.ReadFile(*archivePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "verify: %v\n", err)
		return 1
	}
	manifest, err := capabilitypack.ValidateArchive(data, capabilitypack.DefaultVocabulary())
	if err != nil {
		fmt.Fprintf(os.Stderr, "verify: %v\n", err)
		return 1
	}
	fmt.Printf("verified: %s\n", manifest.Ref())
	fmt.Printf("sha256: %s\n", capabilitypack.ArchiveDigest(data))
	return 0
}
