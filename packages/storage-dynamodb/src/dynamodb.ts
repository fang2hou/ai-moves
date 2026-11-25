import type { StorageRepositories } from "@ai-moves/contracts/ports/storage";

import type { DynamoDbApi } from "./api.ts";
import { createAdminRepos } from "./admin.ts";
import { createAlertRepo } from "./alerts.ts";
import { createAnalysisRepo } from "./analyses.ts";
import { createContext, DEFAULT_MAX_ATTEMPTS } from "./context.ts";
import { createDeliveryRepo } from "./deliveries.ts";
import { createItemRepos } from "./items.ts";
import { createSourceRepo } from "./sources.ts";

export interface DynamoDbStorageOptions {
  readonly api: DynamoDbApi;
  readonly tableName: string;
  // Compare-and-set attempts per call before giving up with STORAGE_UNAVAILABLE.
  readonly maxAttempts?: number;
}

export function createDynamoDbStorage(options: DynamoDbStorageOptions): StorageRepositories {
  const context = createContext(
    options.api,
    options.tableName,
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  );
  return {
    sources: createSourceRepo(context),
    ...createItemRepos(context),
    analyses: createAnalysisRepo(context),
    alerts: createAlertRepo(context),
    deliveries: createDeliveryRepo(context),
    ...createAdminRepos(context),
  };
}
