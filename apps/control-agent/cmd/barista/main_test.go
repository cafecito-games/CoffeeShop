package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHelpExitsSuccessfully(t *testing.T) {
	require.Equal(t, 0, run([]string{"--help"}))
}

func TestInvalidConfigurationNeverConnects(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	t.Cleanup(server.Close)
	t.Setenv("CONTROL_ENDPOINT", server.URL)
	t.Setenv("WORKSPACE_ROOTS", "relative/workspace")

	require.Equal(t, 2, run([]string{"--name", "Worker 1", "--id", "worker-1"}))
	require.Zero(t, requests.Load())
}
