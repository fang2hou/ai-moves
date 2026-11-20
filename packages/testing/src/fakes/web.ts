import type { WebDocument, WebFetcher } from "@ai-moves/contracts/ports/sources";

import { type ScriptStep, scriptedMethod } from "./script.ts";

export interface ScriptedWebFetcher extends WebFetcher {
  readonly calls: readonly [url: string][];
}

export function createScriptedWebFetcher(
  steps: readonly ScriptStep<WebDocument>[],
): ScriptedWebFetcher {
  const fetchText = scriptedMethod<[string], WebDocument>("WebFetcher.fetchText", steps);
  return { fetchText: fetchText.run, calls: fetchText.calls };
}
