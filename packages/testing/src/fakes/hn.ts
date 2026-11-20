import type { HnClient, HnCommentTree, HnStory } from "@ai-moves/contracts/ports/sources";

import { type ScriptStep, scriptedMethod } from "./script.ts";

export interface HnScript {
  readonly listTopStoryIds?: readonly ScriptStep<readonly number[]>[];
  readonly getStory?: readonly ScriptStep<HnStory | null>[];
  readonly getCommentTree?: readonly ScriptStep<HnCommentTree>[];
}

export interface ScriptedHnClient extends HnClient {
  readonly calls: {
    readonly listTopStoryIds: readonly [][];
    readonly getStory: readonly [id: number][];
    readonly getCommentTree: readonly [storyId: number][];
  };
}

export function createScriptedHnClient(script: HnScript): ScriptedHnClient {
  const top = scriptedMethod<[], readonly number[]>(
    "HnClient.listTopStoryIds",
    script.listTopStoryIds,
  );
  const story = scriptedMethod<[number], HnStory | null>("HnClient.getStory", script.getStory);
  const comments = scriptedMethod<[number], HnCommentTree>(
    "HnClient.getCommentTree",
    script.getCommentTree,
  );
  return {
    listTopStoryIds: top.run,
    getStory: story.run,
    getCommentTree: comments.run,
    calls: { listTopStoryIds: top.calls, getStory: story.calls, getCommentTree: comments.calls },
  };
}
