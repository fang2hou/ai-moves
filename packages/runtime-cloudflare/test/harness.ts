import type { R2BlobBinding } from "../src/blob-store.ts";
import type { KVCacheBinding } from "../src/cache.ts";
import type { QueueName } from "@ai-moves/contracts/messages";
import type { CloudflareQueueBinding } from "../src/queue.ts";
import { Miniflare } from "miniflare";

export interface RuntimeCloudflareHarness {
  readonly miniflare: Miniflare;
  readonly queues: Readonly<Record<QueueName, CloudflareQueueBinding>>;
  readonly bucket: R2BlobBinding;
  readonly namespace: KVCacheBinding;
}

export async function createRuntimeCloudflareHarness(): Promise<RuntimeCloudflareHarness> {
  const miniflare = new Miniflare({
    host: "127.0.0.1",
    compatibilityDate: "2026-07-30",
    modules: true,
    queueProducers: {
      Q_POLL: "q-poll",
      Q_TRIAGE: "q-triage",
      Q_DEEP: "q-deep",
      Q_DELIVER: "q-deliver",
    },
    queueConsumers: ["q-poll", "q-triage", "q-deep", "q-deliver"],
    r2Buckets: { BUCKET: "test-bucket" },
    kvNamespaces: { CACHE: "test-cache" },
    outboundService: () => {
      throw new Error("Unexpected outbound Worker request");
    },
    script: `
      export default {
        fetch() { return new Response('ok'); },
        async queue(batch, env) {
          await env.CACHE.put(
            'queue:' + batch.queue,
            JSON.stringify(batch.messages.map((message) => message.body)),
          );
        },
      };
    `,
  });
  const [poll, triage, deep, deliver, bucket, namespace] = await Promise.all([
    miniflare.getQueueProducer("Q_POLL"),
    miniflare.getQueueProducer("Q_TRIAGE"),
    miniflare.getQueueProducer("Q_DEEP"),
    miniflare.getQueueProducer("Q_DELIVER"),
    miniflare.getR2Bucket("BUCKET"),
    miniflare.getKVNamespace("CACHE"),
  ]);
  return {
    miniflare,
    queues: {
      "q-poll": poll,
      "q-triage": triage,
      "q-deep": deep,
      "q-deliver": deliver,
    },
    bucket,
    namespace,
  };
}
