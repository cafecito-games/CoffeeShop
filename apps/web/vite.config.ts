import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const hubTarget = environment.COFFEE_SHOP_DEV_PROXY_TARGET || "http://localhost:8787";
  const hubWebSocketTarget = hubTarget.replace(/^http/, "ws");
  return {
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: { globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"] },
      manifest: {
        name: "Coffee Shop Agent Control Plane", short_name: "Coffee Shop", description: "One room for every agent and compute machine.",
        theme_color: "#0b0c0e", background_color: "#0b0c0e", display: "standalone", orientation: "portrait-primary",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ]
      }
    })
  ],
  server: {
    proxy: {
      "/api": { target: hubTarget, changeOrigin: true },
      "/events": { target: hubWebSocketTarget, ws: true, changeOrigin: true },
      // The connect dialog builds a bridge hub URL from this app's origin, which is the dev server
      // in development and the hub itself in production. Proxying the endpoint keeps the generated
      // `.mcp.json` correct in both.
      "/orchestrator-client": { target: hubWebSocketTarget, ws: true, changeOrigin: true }
    }
  }
  };
});
