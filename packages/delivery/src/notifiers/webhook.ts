import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Destination } from "@ai-moves/contracts/entities";
import type { Notifier, NotifyReceipt } from "@ai-moves/contracts/ports/notifier";
import type { HttpFetch, SecretProvider } from "@ai-moves/contracts/ports/runtime";
import type { DestinationChannel } from "@ai-moves/contracts/states";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { renderDiscord } from "../render/discord.ts";
import { renderSlack } from "../render/slack.ts";

const maxReceiptBytes = 64 * 1024;

export function createWebhookNotifier(
  channel: DestinationChannel,
  transport: HttpFetch,
  secrets: SecretProvider,
): Notifier {
  return {
    channel,
    async send(destination: Destination, doc: AlertDoc): Promise<NotifyReceipt> {
      if (destination.channel !== channel) throw new AppError("CONFIG_INVALID");
      const secret = await secrets.get(destination.secret_ref);
      let url: URL;
      try {
        url = new URL(secret);
      } catch {
        throw new AppError("CONFIG_INVALID");
      }
      const expectedHost = channel === "slack" ? "hooks.slack.com" : "discord.com";
      if (
        url.protocol !== "https:" ||
        url.hostname !== expectedHost ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
      ) {
        throw new AppError("CONFIG_INVALID");
      }
      if (channel === "discord") url.searchParams.set("wait", "true");
      const payload = channel === "slack" ? renderSlack(doc) : renderDiscord(doc);
      let response: Response;
      try {
        response = await transport(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            // Workers reject "error" as a redirect mode, and a redirect is not a
            // success anyway: "manual" surfaces the 3xx, which the check below
            // treats as a rejection.
            redirect: "manual",
          }),
        );
      } catch {
        throw new AppError("OUTCOME_UNKNOWN");
      }
      if (!response.ok || channel === "slack") {
        // Cleanup must not delay the outcome or replace it with a cancellation error.
        void response.body?.cancel().catch(() => undefined);
        // A 5xx was still an answer: the provider refused the message, so a retry cannot
        // duplicate it. Only a send with no answer is unknowable.
        if (response.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE");
        if (response.status === 429) throw new AppError("UPSTREAM_RATE_LIMITED");
        if (!response.ok) throw new AppError("UPSTREAM_REJECTED");
        return { provider_message_id: null };
      }
      try {
        const value: unknown = JSON.parse(await readReceipt(response));
        if (
          typeof value === "object" &&
          value !== null &&
          "id" in value &&
          typeof value.id === "string" &&
          value.id.length > 0 &&
          value.id.length <= 128
        ) {
          return { provider_message_id: value.id };
        }
      } catch {
        throw new AppError("OUTCOME_UNKNOWN");
      }
      throw new AppError("OUTCOME_UNKNOWN");
    },
  };
}

async function readReceipt(response: Response): Promise<string> {
  if (response.bodyUsed) throw new AppError("OUTCOME_UNKNOWN");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new AppError("OUTCOME_UNKNOWN");
  const decoder = new TextDecoder();
  let remaining = maxReceiptBytes;
  let text = "";
  let finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        return text + decoder.decode();
      }
      remaining -= chunk.value.byteLength;
      if (remaining < 0) throw new AppError("OUTCOME_UNKNOWN");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    // Do not await cancellation; an unreadable receipt is already ambiguous.
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
