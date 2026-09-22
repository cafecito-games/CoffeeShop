package acp

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func TestTruncateBytesNeverSplitsRunes(t *testing.T) {
	for _, input := range []string{"héllo", "日本語"} {
		for limit := 0; limit <= len(input); limit++ {
			truncated := truncateBytes(input, limit)
			require.LessOrEqual(t, len(truncated), limit, "limit %d of %q", limit, input)
			require.True(t, utf8.ValidString(truncated), "limit %d of %q", limit, input)
			require.True(t, strings.HasPrefix(input, truncated), "limit %d of %q", limit, input)
		}
	}
}

func TestSplitBytesProperties(t *testing.T) {
	cases := []struct {
		name         string
		input        string
		limit        int
		expectSingle bool
	}{
		{name: "ascii", input: "hello world", limit: 4},
		{name: "multi-byte", input: "日本語のテスト", limit: 6},
		// Limits stay at or above four bytes, the widest UTF-8 rune: a smaller limit cannot keep
		// every chunk valid UTF-8 while still reproducing the input byte for byte.
		{name: "mixed", input: "ab日cd本", limit: 4},
		{name: "ascii at the limit", input: "abcdefgh", limit: 8, expectSingle: true},
		{name: "multi-byte at the limit", input: "日本語", limit: 9, expectSingle: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			chunks := splitBytes(testCase.input, testCase.limit)
			require.Equal(t, testCase.input, strings.Join(chunks, ""))
			for _, chunk := range chunks {
				require.LessOrEqual(t, len(chunk), testCase.limit)
				require.True(t, utf8.ValidString(chunk))
			}
			if testCase.expectSingle {
				require.Len(t, chunks, 1)
			}
		})
	}
}

func TestRedactorIgnoresEmptySecretsAndRedactsAll(t *testing.T) {
	redaction := newRedactor([]string{"", "alpha-secret", "beta"})
	require.Equal(t, "[redacted] and [redacted] [redacted]", redaction.apply("alpha-secret and beta beta"))
	require.Equal(t, "untouched", redaction.apply("untouched"))
}

func TestStderrTailReturnsSmallWritesTrimmed(t *testing.T) {
	tail := NewStderrTail(64, nil)
	_, err := tail.Write([]byte("  everything is fine  \n"))
	require.NoError(t, err)
	require.Equal(t, "everything is fine", tail.String())
}

func TestStderrTailBoundsRenderedLength(t *testing.T) {
	tail := NewStderrTail(32, nil)
	_, err := tail.Write([]byte(strings.Repeat("x", 1000)))
	require.NoError(t, err)
	rendered := tail.String()
	require.LessOrEqual(t, len(rendered), 32)
	require.Equal(t, strings.Repeat("x", 32), rendered)
}

func TestStderrTailRedactsSecretWrittenInFull(t *testing.T) {
	tail := NewStderrTail(1024, []string{"hunter2"})
	_, err := tail.Write([]byte("password=hunter2\n"))
	require.NoError(t, err)
	require.Equal(t, "password=[redacted]", tail.String())
}

func TestStderrTailHidesSecretFragmentAtWindowStart(t *testing.T) {
	const limit = 16
	secret := "supersecret-token-value"
	tail := NewStderrTail(limit, []string{secret})

	// The retained window is limit plus the longest secret bytes, so these write sizes place the
	// window start in the middle of the secret.
	_, err := tail.Write([]byte(strings.Repeat("y", 64)))
	require.NoError(t, err)
	_, err = tail.Write([]byte(secret))
	require.NoError(t, err)
	_, err = tail.Write([]byte(strings.Repeat("z", 18)))
	require.NoError(t, err)

	rendered := tail.String()
	require.LessOrEqual(t, len(rendered), limit)
	for start := 0; start+8 <= len(secret); start++ {
		require.NotContains(t, rendered, secret[start:start+8], "fragment %q survived", secret[start:start+8])
	}
}
