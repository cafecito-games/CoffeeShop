import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@coffee-shop/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"]
  }
});
