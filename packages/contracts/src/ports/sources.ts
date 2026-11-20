import { z } from "zod";

import type { RepoRef } from "../entities.ts";
import {
  ContentHashSchema,
  EpochMsSchema,
  HttpUrlSchema,
  NonNegativeIntSchema,
} from "../primitives.ts";

// Normalised shapes the source ports return. Adapters validate raw upstream responses and map them
// to these; nothing downstream sees a provider payload.

// Item types of the official Hacker News API (github.com/HackerNews/API).
export const HN_ITEM_TYPES = ["job", "story", "comment", "poll", "pollopt"] as const;
export const HnItemTypeSchema = z.enum(HN_ITEM_TYPES);
export type HnItemType = z.infer<typeof HnItemTypeSchema>;

export const HnStorySchema = z.object({
  id: z.int().positive(),
  type: HnItemTypeSchema,
  title: z.string(),
  url: HttpUrlSchema.nullable(),
  text: z.string().nullable(),
  author: z.string().nullable(),
  points: NonNegativeIntSchema,
  comments: NonNegativeIntSchema,
  published_at: EpochMsSchema,
  deleted: z.boolean(),
  dead: z.boolean(),
});
export type HnStory = z.infer<typeof HnStorySchema>;

export const HnCommentSchema = z.object({
  id: z.int().positive(),
  parent_id: z.int().positive(),
  depth: NonNegativeIntSchema,
  author: z.string().nullable(),
  text: z.string(),
  published_at: EpochMsSchema,
});
export type HnComment = z.infer<typeof HnCommentSchema>;

export const HnCommentTreeSchema = z.object({
  story_id: z.int().positive(),
  // Flattened in Hacker News display order.
  comments: z.array(HnCommentSchema),
});
export type HnCommentTree = z.infer<typeof HnCommentTreeSchema>;

export interface HnClient {
  // Story ids in rank order, best first.
  listTopStoryIds(): Promise<readonly number[]>;
  getStory(id: number): Promise<HnStory | null>;
  getCommentTree(storyId: number): Promise<HnCommentTree>;
}

export const GitHubReleaseSchema = z.object({
  tag: z.string().min(1),
  name: z.string().nullable(),
  body: z.string().nullable(),
  prerelease: z.boolean(),
  draft: z.boolean(),
  published_at: EpochMsSchema.nullable(),
  url: HttpUrlSchema,
});
export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>;

export const GitHubTagSchema = z.object({
  name: z.string().min(1),
  commit_sha: z.string().min(1),
});
export type GitHubTag = z.infer<typeof GitHubTagSchema>;

export const GitHubFileSchema = z.object({
  path: z.string().min(1),
  sha: z.string().min(1),
  text: z.string(),
});
export type GitHubFile = z.infer<typeof GitHubFileSchema>;

export const GitHubCompareSchema = z.object({
  base: z.string().min(1),
  head: z.string().min(1),
  commit_messages: z.array(z.string()),
  url: HttpUrlSchema,
});
export type GitHubCompare = z.infer<typeof GitHubCompareSchema>;

export type Conditional<Value> =
  | { readonly status: "not_modified" }
  | { readonly status: "modified"; readonly etag: string | null; readonly value: Value };

export interface ConditionalOptions {
  readonly etag: string | null;
}

// Credentials are only ever sent to api.github.com (architecture 8.1).
export interface GitHubClient {
  listReleases(
    repo: RepoRef,
    options: ConditionalOptions,
  ): Promise<Conditional<readonly GitHubRelease[]>>;
  listTags(repo: RepoRef, options: ConditionalOptions): Promise<Conditional<readonly GitHubTag[]>>;
  // Resolves null when the file does not exist.
  getFile(
    repo: RepoRef,
    path: string,
    options: ConditionalOptions,
  ): Promise<Conditional<GitHubFile | null>>;
  compare(repo: RepoRef, base: string, head: string): Promise<GitHubCompare>;
}

export const WebDocumentSchema = z.object({
  requested_url: HttpUrlSchema,
  final_url: HttpUrlSchema,
  content_type: z.string().min(1),
  text: z.string(),
  truncated: z.boolean(),
  content_hash: ContentHashSchema,
});
export type WebDocument = z.infer<typeof WebDocumentSchema>;

// Fetches attacker-controlled URLs under the SSRF rules of architecture 10. Rejects with
// SSRF_BLOCKED, CONTENT_UNSUPPORTED, or an UPSTREAM_* code.
export interface WebFetcher {
  fetchText(url: string): Promise<WebDocument>;
}
