import {
  SECRET_PROVIDER_FIXTURES,
  secretProviderContract,
} from "@ai-moves/testing/contract/secret-provider";
import { telemetryContract } from "@ai-moves/testing/contract/telemetry";
import { runPortContract } from "@ai-moves/testing/contract/define";

import { createCloudflareSecretProvider } from "../src/secrets.ts";
import { createCloudflareTelemetry, type CloudflareMetricRecord } from "../src/telemetry.ts";

runPortContract(secretProviderContract, "Worker secret bindings", {
  create: () => createCloudflareSecretProvider(SECRET_PROVIDER_FIXTURES),
});

runPortContract(telemetryContract, "structured Worker sink", {
  create: () => {
    const records: unknown[] = [];
    const counts: CloudflareMetricRecord[] = [];
    return {
      telemetry: createCloudflareTelemetry((record) => {
        if ("metric" in record) {
          counts.push(record);
        } else {
          records.push(record);
        }
      }),
      records: () => records,
      counts: () => counts,
    };
  },
});
