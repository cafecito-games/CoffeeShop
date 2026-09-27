// Command generate-preview-bundle is the byte-faithful Go archive/tar producer for Hub fixtures.
package main

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"strings"
)

type fixtureFile struct {
	path string
	body string
}

func main() {
	gzipWriter, err := gzip.NewWriterLevel(os.Stdout, gzip.BestCompression)
	if err != nil {
		panic(err)
	}
	gzipWriter.Name = ""
	gzipWriter.Comment = ""
	tarWriter := tar.NewWriter(gzipWriter)

	files := []fixtureFile{
		{path: "site/app.js", body: "document.querySelector('h1').dataset.ready = 'true';\n"},
		{path: "site/index.html", body: "<!doctype html><html><body><h1>Coffee Shop</h1><script src=\"app.js\"></script></body></html>\n"},
	}
	if len(os.Args) == 2 && os.Args[1] == "--long-pax" {
		files = []fixtureFile{{path: "site/" + strings.Repeat("segment/", 40) + "index.html", body: "PAX path\n"}}
	}
	for _, file := range files {
		header := &tar.Header{
			Name: file.path,
			Mode: 0o644,
			Size: int64(len(file.body)),
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			panic(err)
		}
		if _, err := io.WriteString(tarWriter, file.body); err != nil {
			panic(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		panic(err)
	}
	if err := gzipWriter.Close(); err != nil {
		panic(err)
	}
}
