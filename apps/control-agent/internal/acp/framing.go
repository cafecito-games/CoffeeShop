package acp

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

var (
	// ErrFrameTooLarge reports a stdout line longer than the configured frame limit.
	ErrFrameTooLarge = errors.New("acp frame exceeds its size limit")
	// ErrUnterminatedFrame reports stdout that ended in the middle of a line.
	ErrUnterminatedFrame = errors.New("acp stdout ended inside an unterminated frame")
	// ErrStdoutContamination reports stdout bytes that are not a single JSON-RPC object.
	ErrStdoutContamination = errors.New("acp stdout contains a non-protocol line")
)

const frameReadBufferBytes = 64 * 1024

// frameReader splits newline-delimited frames without ever holding more than limit bytes of one
// frame, so an adversarial adapter cannot force unbounded allocation.
type frameReader struct {
	reader *bufio.Reader
	limit  int
	frame  []byte
}

func newFrameReader(reader io.Reader, limit int) *frameReader {
	return &frameReader{reader: bufio.NewReaderSize(reader, frameReadBufferBytes), limit: limit}
}

// next returns the next frame without its newline. It returns io.EOF only at a clean frame
// boundary. The returned slice is valid until the following call.
func (reader *frameReader) next() ([]byte, error) {
	reader.frame = reader.frame[:0]
	for {
		segment, err := reader.reader.ReadSlice('\n')
		complete := err == nil
		if complete {
			segment = segment[:len(segment)-1]
		}
		if len(reader.frame)+len(segment) > reader.limit {
			return nil, fmt.Errorf("%w (%d bytes)", ErrFrameTooLarge, reader.limit)
		}
		reader.frame = append(reader.frame, segment...)
		switch {
		case complete:
			return reader.validate(reader.frame)
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF):
			if len(reader.frame) == 0 {
				return nil, io.EOF
			}
			return nil, ErrUnterminatedFrame
		default:
			return nil, err
		}
	}
}

func (reader *frameReader) validate(frame []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace(frame)
	if len(trimmed) == 0 || trimmed[0] != '{' || !utf8.Valid(frame) {
		return nil, ErrStdoutContamination
	}
	return frame, nil
}
