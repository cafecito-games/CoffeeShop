package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// recorder appends one JSON object per line to a file named after the role and process ID in the
// test-owned record directory. Without the directory it records nothing.
type recorder struct {
	mu   sync.Mutex
	file *os.File
}

var activeRecorder *recorder

func newRecorder(role string) *recorder {
	result := &recorder{}
	activeRecorder = result
	directory := os.Getenv(recordDirectoryVariable)
	if directory == "" {
		return result
	}
	file, err := os.OpenFile(filepath.Join(directory, role+"-"+strconv.Itoa(os.Getpid())+".jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return result
	}
	result.file = file
	present := map[string]bool{}
	for _, name := range observedEnvironment {
		_, set := os.LookupEnv(name)
		present[name] = set
	}
	workingDirectory, _ := os.Getwd()
	result.write(map[string]any{"event": "start", "role": role, "pid": os.Getpid(), "environment": present, "workingDirectory": workingDirectory})
	return result
}

func (recorder *recorder) write(entry map[string]any) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if recorder.file == nil {
		return
	}
	entry["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	encoded, err := json.Marshal(entry)
	if err != nil {
		return
	}
	_, _ = recorder.file.Write(append(encoded, '\n'))
}

func (recorder *recorder) exit(code int) {
	recorder.write(map[string]any{"event": "exit", "code": code})
}

// terminate records the exit and ends the process; every exit path goes through it so the test can
// tell a process that ended from one that leaked.
func terminate(code int) {
	if activeRecorder != nil {
		activeRecorder.exit(code)
	}
	os.Exit(code)
}
