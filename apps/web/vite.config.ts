import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
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
  server: { proxy: { "/api": "http://localhost:8787", "/events": { target: "ws://localhost:8787", ws: true } } }
});
