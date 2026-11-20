import type { AlertDoc } from "@ai-moves/contracts/alert-doc";
import type { Destination } from "@ai-moves/contracts/entities";
import type { Notifier, NotifyReceipt } from "@ai-moves/contracts/ports/notifier";
import type { HttpFetch, SecretProvider } from "@ai-moves/contracts/ports/runtime";
import type { DestinationChannel } from "@ai-moves/contracts/states";
import { AppError } from "@ai-moves/kernel/errors/app-error";

import { renderDiscord } from "../render/discord.ts";
import { renderSlack } from "../render/slack.ts";

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
            redirect: "error",
          }),
        );
      } catch {
        throw new AppError("OUTCOME_UNKNOWN");
      }
      if (response.status === 429) throw new AppError("UPSTREAM_RATE_LIMITED");
      if (response.status >= 500) throw new AppError("UPSTREAM_UNAVAILABLE");
      if (!response.ok) throw new AppError("UPSTREAM_REJECTED");
      if (channel === "slack") return { provider_message_id: null };
      try {
        const value: unknown = await response.json();
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
