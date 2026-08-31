import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dshBrowserCompatibilityAliases } from "@dshrbox/runtime-browser/vite";

const host = process.env.TAURI_DEV_HOST;
const platform = process.env.TAURI_ENV_PLATFORM;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: react(),
  resolve: {
    alias: dshBrowserCompatibilityAliases(),
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: platform === "windows" ? "chrome105" : "safari15",
    minify: process.env.TAURI_ENV_DEBUG ? false : ("esbuild" as const),
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
}));
