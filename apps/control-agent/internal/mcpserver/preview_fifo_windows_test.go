//go:build windows

package mcpserver

import "errors"

func makeFIFO(string) error { return errors.New("FIFOs are unavailable on Windows") }
