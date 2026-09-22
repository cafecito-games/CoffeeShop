package acp

import (
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// jsonObjectOfExactLength builds a valid JSON object whose encoded length is exactly length bytes.
func jsonObjectOfExactLength(length int) string {
	const prefix = `{"value":"`
	const suffix = `"}`
	padding := length - len(prefix) - len(suffix)
	return prefix + strings.Repeat("a", padding) + suffix
}

func TestFrameReaderAcceptsFrameAtLimit(t *testing.T) {
	const limit = 16
	frame := jsonObjectOfExactLength(limit)
	reader := newFrameReader(strings.NewReader(frame+"\n"), limit)
	received, err := reader.next()
	require.NoError(t, err)
	require.Equal(t, frame, string(received))
}

func TestFrameReaderRejectsFrameBeyondLimit(t *testing.T) {
	const limit = 16
	frame := jsonObjectOfExactLength(limit + 1)
	reader := newFrameReader(strings.NewReader(frame+"\n"), limit)
	_, err := reader.next()
	require.ErrorIs(t, err, ErrFrameTooLarge)
}

func TestFrameReaderAcceptsMaximumFrame(t *testing.T) {
	frame := jsonObjectOfExactLength(MaximumFrameBytes)
	reader := newFrameReader(strings.NewReader(frame+"\n"), MaximumFrameBytes)
	received, err := reader.next()
	require.NoError(t, err)
	require.Len(t, received, MaximumFrameBytes)
}

func TestFrameReaderRejectsFrameBeyondMaximum(t *testing.T) {
	frame := jsonObjectOfExactLength(MaximumFrameBytes + 1)
	reader := newFrameReader(strings.NewReader(frame+"\n"), MaximumFrameBytes)
	_, err := reader.next()
	require.ErrorIs(t, err, ErrFrameTooLarge)
}

func TestFrameReaderReturnsFramesInOrderThenEOF(t *testing.T) {
	reader := newFrameReader(strings.NewReader("{\"first\":1}\n{\"second\":2}\n{\"third\":3}\n"), 1024)
	for _, expected := range []string{`{"first":1}`, `{"second":2}`, `{"third":3}`} {
		received, err := reader.next()
		require.NoError(t, err)
		require.Equal(t, expected, string(received))
	}
	_, err := reader.next()
	require.ErrorIs(t, err, io.EOF)
}

func TestFrameReaderRejectsTrailingBytesWithoutNewline(t *testing.T) {
	reader := newFrameReader(strings.NewReader("{\"first\":1}\n{\"second\":2}"), 1024)
	received, err := reader.next()
	require.NoError(t, err)
	require.Equal(t, `{"first":1}`, string(received))
	_, err = reader.next()
	require.ErrorIs(t, err, ErrUnterminatedFrame)
}

func TestFrameReaderRejectsContaminatedLines(t *testing.T) {
	cases := []struct {
		name  string
		frame string
	}{
		{name: "plain text", frame: "hello"},
		{name: "empty line", frame: ""},
		{name: "json array", frame: "[1]"},
		{name: "invalid utf-8", frame: "{\"a\":\"\xff\"}"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reader := newFrameReader(strings.NewReader(testCase.frame+"\n"), 1024)
			_, err := reader.next()
			require.ErrorIs(t, err, ErrStdoutContamination)
		})
	}
}

// singleByteReader delivers one byte per Read call to exercise reassembly across partial reads.
type singleByteReader struct {
	data   []byte
	offset int
}

func (reader *singleByteReader) Read(destination []byte) (int, error) {
	if reader.offset >= len(reader.data) {
		return 0, io.EOF
	}
	if len(destination) == 0 {
		return 0, nil
	}
	destination[0] = reader.data[reader.offset]
	reader.offset++
	return 1, nil
}

func TestFrameReaderReassemblesFramesFromPartialReads(t *testing.T) {
	source := &singleByteReader{data: []byte("{\"first\":1}\n{\"second\":2}\n")}
	reader := newFrameReader(source, 1024)
	for _, expected := range []string{`{"first":1}`, `{"second":2}`} {
		received, err := reader.next()
		require.NoError(t, err)
		require.Equal(t, expected, string(received))
	}
	_, err := reader.next()
	require.ErrorIs(t, err, io.EOF)
}
