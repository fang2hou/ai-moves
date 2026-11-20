import type { RepoRef } from "@ai-moves/contracts/entities";
import type {
  Conditional,
  ConditionalOptions,
  GitHubClient,
  GitHubCompare,
  GitHubFile,
  GitHubRelease,
  GitHubTag,
} from "@ai-moves/contracts/ports/sources";

import { type ScriptStep, scriptedMethod } from "./script.ts";

type RepoOptions = [repo: RepoRef, options: ConditionalOptions];
type FileRequest = [repo: RepoRef, path: string, options: ConditionalOptions];
type CompareRequest = [repo: RepoRef, base: string, head: string];

export interface GitHubScript {
  readonly listReleases?: readonly ScriptStep<Conditional<readonly GitHubRelease[]>>[];
  readonly listTags?: readonly ScriptStep<Conditional<readonly GitHubTag[]>>[];
  readonly getFile?: readonly ScriptStep<Conditional<GitHubFile | null>>[];
  readonly compare?: readonly ScriptStep<GitHubCompare>[];
}

export interface ScriptedGitHubClient extends GitHubClient {
  readonly calls: {
    readonly listReleases: readonly RepoOptions[];
    readonly listTags: readonly RepoOptions[];
    readonly getFile: readonly FileRequest[];
    readonly compare: readonly CompareRequest[];
  };
}

export function createScriptedGitHubClient(script: GitHubScript): ScriptedGitHubClient {
  const releases = scriptedMethod<RepoOptions, Conditional<readonly GitHubRelease[]>>(
    "GitHubClient.listReleases",
    script.listReleases,
  );
  const tags = scriptedMethod<RepoOptions, Conditional<readonly GitHubTag[]>>(
    "GitHubClient.listTags",
    script.listTags,
  );
  const file = scriptedMethod<FileRequest, Conditional<GitHubFile | null>>(
    "GitHubClient.getFile",
    script.getFile,
  );
  const compare = scriptedMethod<CompareRequest, GitHubCompare>(
    "GitHubClient.compare",
    script.compare,
  );
  return {
    listReleases: releases.run,
    listTags: tags.run,
    getFile: file.run,
    compare: compare.run,
    calls: {
      listReleases: releases.calls,
      listTags: tags.calls,
      getFile: file.calls,
      compare: compare.calls,
    },
  };
}
