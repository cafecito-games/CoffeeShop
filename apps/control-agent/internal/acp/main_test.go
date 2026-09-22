package acp

import (
	"os"
	"testing"

	"github.com/cafecito-games/CoffeeShop/apps/control-agent/internal/acp/acptest"
)

func TestMain(m *testing.M) {
	acptest.RunIfRequested()
	os.Exit(m.Run())
}
