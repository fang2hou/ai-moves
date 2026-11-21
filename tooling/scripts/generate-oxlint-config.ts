import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildOxlintConfig } from "../src/oxlint-config.ts";

const target = fileURLToPath(new URL("../../.oxlintrc.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOxlintConfig(), null, 2)}\n`);
