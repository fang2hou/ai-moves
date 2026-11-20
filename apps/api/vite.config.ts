import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2024",
    outDir: "dist/worker",
    lib: {
      entry: fileURLToPath(new URL("./src/worker.ts", import.meta.url)),
      formats: ["es"],
      fileName: "worker",
    },
  },
});
