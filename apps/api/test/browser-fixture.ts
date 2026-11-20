import { fileURLToPath } from "node:url";

import { bundleWorker, startDesk } from "./emulator.ts";
import { seedDesk, testAccess } from "./fixtures.ts";

const [script, access] = await Promise.all([bundleWorker(), testAccess()]);
const { worker, database } = await startDesk(script, access.bindings, {
  assertion: await access.sign(),
  directory: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
try {
  await seedDesk(database, 19);
  process.stdout.write(`Local desk: ${await worker.ready}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await worker.dispose();
}
