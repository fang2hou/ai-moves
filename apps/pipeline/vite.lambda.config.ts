import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// One self-contained ES module for every pipeline Lambda function: workspace packages are
// inlined, and only Node built-ins stay external. Handlers: index.tick, index.queue, and index.mcp.
export default defineConfig({
  build: {
    ssr: fileURLToPath(new URL("./src/aws/handler.ts", import.meta.url)),
    target: "node24",
    outDir: "dist/lambda",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "index.mjs" } },
  },
  ssr: { noExternal: true },
});
