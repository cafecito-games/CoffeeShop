package acp

import (
	"strings"
	"sync"
	"unicode/utf8"
)

const redactionMarker = "[redacted]"

// redactor replaces every configured secret before a value leaves the ACP package.
type redactor struct {
	secrets []string
}

func newRedactor(secrets []string) redactor {
	kept := make([]string, 0, len(secrets))
	for _, secret := range secrets {
		if secret != "" {
			kept = append(kept, secret)
		}
	}
	return redactor{secrets: kept}
}

func (redaction redactor) apply(value string) string {
	for _, secret := range redaction.secrets {
		value = strings.ReplaceAll(value, secret, redactionMarker)
	}
	return value
}

// longestSecret is the widest window in which a truncated secret fragment may survive.
func (redaction redactor) longestSecret() int {
	longest := 0
	for _, secret := range redaction.secrets {
		longest = max(longest, len(secret))
	}
	return longest
}

// truncateBytes shortens value to at most limit bytes without splitting a UTF-8 sequence.
func truncateBytes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut]
}

// splitBytes divides value into chunks of at most limit bytes on UTF-8 boundaries.
func splitBytes(value string, limit int) []string {
	chunks := []string{}
	for len(value) > limit {
		chunk := truncateBytes(value, limit)
		if chunk == "" {
			chunk = value[:limit]
		}
		chunks = append(chunks, chunk)
		value = value[len(chunk):]
	}
	return append(chunks, value)
}

// tailBuffer retains the most recent bytes written to it, for bounded stderr diagnostics.
type tailBuffer struct {
	mu        sync.Mutex
	limit     int
	data      []byte
	truncated bool
}

func newTailBuffer(limit int) *tailBuffer {
	return &tailBuffer{limit: limit}
}

func (buffer *tailBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	written := len(data)
	if len(data) >= buffer.limit {
		buffer.data = append(buffer.data[:0], data[len(data)-buffer.limit:]...)
		buffer.truncated = true
		return written, nil
	}
	if overflow := len(buffer.data) + len(data) - buffer.limit; overflow > 0 {
		buffer.data = append(buffer.data[:0], buffer.data[overflow:]...)
		buffer.truncated = true
	}
	buffer.data = append(buffer.data, data...)
	return written, nil
}

// StderrTail captures the end of adapter stderr. Its capacity is widened by the longest secret so
// that, after redaction, a secret cut at the start of the window can be dropped rather than
// leaked as a fragment.
type StderrTail struct {
	buffer    *tailBuffer
	redaction redactor
	limit     int
}

// NewStderrTail returns a writer retaining at most limit bytes of redacted output.
func NewStderrTail(limit int, secrets []string) *StderrTail {
	redaction := newRedactor(secrets)
	return &StderrTail{buffer: newTailBuffer(limit + redaction.longestSecret()), redaction: redaction, limit: limit}
}

func (tail *StderrTail) Write(data []byte) (int, error) {
	return tail.buffer.Write(data)
}

// String returns the redacted, trimmed tail, never longer than the configured limit.
func (tail *StderrTail) String() string {
	tail.buffer.mu.Lock()
	raw := string(tail.buffer.data)
	truncated := tail.buffer.truncated
	tail.buffer.mu.Unlock()
	if !utf8.ValidString(raw) {
		raw = strings.ToValidUTF8(raw, "�")
	}
	value := tail.redaction.apply(raw)
	if truncated {
		value = value[min(len(value), tail.redaction.longestSecret()):]
		for len(value) > 0 && !utf8.RuneStart(value[0]) {
			value = value[1:]
		}
	}
	if len(value) > tail.limit {
		value = value[len(value)-tail.limit:]
		for len(value) > 0 && !utf8.RuneStart(value[0]) {
			value = value[1:]
		}
	}
	return strings.TrimSpace(value)
}
