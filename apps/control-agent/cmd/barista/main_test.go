package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHelpExitsSuccessfully(t *testing.T) {
	require.Equal(t, 0, run([]string{"--help"}))
}
