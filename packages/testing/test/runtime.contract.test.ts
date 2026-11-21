import { runPortContract } from "@ai-moves/testing/contract/define";
import {
  SECRET_PROVIDER_FIXTURES,
  secretProviderContract,
} from "@ai-moves/testing/contract/secret-provider";
import { telemetryContract } from "@ai-moves/testing/contract/telemetry";
import { createStaticSecretProvider } from "@ai-moves/testing/fakes/secrets";
import { createRecordingTelemetry } from "@ai-moves/testing/fakes/telemetry";

runPortContract(secretProviderContract, "static fake", {
  create: () => createStaticSecretProvider(SECRET_PROVIDER_FIXTURES),
});

runPortContract(telemetryContract, "recording fake", {
  create: () => {
    const telemetry = createRecordingTelemetry();
    return { telemetry, records: () => telemetry.records, counts: () => telemetry.counts };
  },
});
