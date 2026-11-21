import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

const setupNoNetwork = fileURLToPath(new URL("./setup-no-network.ts", import.meta.url));

export function packageProject(name: string): ReturnType<typeof defineProject> {
  return defineProject({
    test: {
      name,
      environment: "node",
      include: ["test/**/*.test.ts"],
      setupFiles: [setupNoNetwork],
      restoreMocks: true,
      unstubGlobals: true,
      unstubEnvs: true,
      sequence: { shuffle: false, concurrent: false },
      testTimeout: 5000,
    },
  });
}
