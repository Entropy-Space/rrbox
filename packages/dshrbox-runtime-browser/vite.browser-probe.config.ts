import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { dshBrowserCompatibilityAliases } from "./src/vite.ts";

export default defineConfig({
  resolve: {
    alias: dshBrowserCompatibilityAliases(),
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(
        new URL("./test/fixtures/browser-worker.ts", import.meta.url),
      ),
      fileName: () => "worker.js",
      formats: ["es"],
    },
    minify: false,
    outDir: "dist/browser-probe",
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
