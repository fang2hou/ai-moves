import {
  HnItemTypeSchema,
  HnStorySchema,
  type HnClient,
  type HnComment,
} from "@ai-moves/contracts/ports/sources";
import {
  HttpUrlSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
} from "@ai-moves/contracts/primitives";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { z } from "zod";

import {
  type ApiOptions,
  checkManualResponse,
  invalidResponse,
  parseUpstream,
  readJson,
  rejectStatus,
  USER_AGENT,
  withDeadline,
} from "./http.ts";

const API = "https://hacker-news.firebaseio.com/v0";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_COMMENT_REQUESTS = 60;
const MAX_TOP_LEVEL_COMMENTS = 30;
const MAX_COMMENT_DEPTH = 2;
const MAX_COMMENT_CHARS = 800;
const ItemIds = z.array(PositiveIntSchema);
const ItemEnvelope = z.object({
  id: PositiveIntSchema,
  type: HnItemTypeSchema.optional(),
  deleted: z.boolean().default(false),
  dead: z.boolean().default(false),
  kids: ItemIds.default([]),
});
const LiveItem = z.object({
  by: z.string().optional(),
  text: z.string().optional(),
  time: NonNegativeIntSchema.max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
});
const StoryFields = LiveItem.extend({
  title: z.string().min(1),
  url: HttpUrlSchema.or(z.literal("")).optional(),
  score: NonNegativeIntSchema.default(0),
  descendants: NonNegativeIntSchema.default(0),
});
const CommentFields = LiveItem.extend({
  parent: PositiveIntSchema,
  text: z.string(),
});

interface CommentNode {
  readonly id: number;
  readonly parentId: number;
  readonly depth: number;
  readonly children: CommentNode[];
  comment?: HnComment;
}

function itemPath(id: number): string {
  if (!PositiveIntSchema.safeParse(id).success) {
    throw new AppError("INPUT_INVALID", { message: "Invalid Hacker News item ID" });
  }
  return `/item/${id}.json`;
}

function inspectItem(raw: unknown, id: number): z.output<typeof ItemEnvelope> | null {
  if (raw === null) {
    return null;
  }
  const item = parseUpstream(ItemEnvelope, raw);
  if (item.id !== id || (item.type === undefined && !item.deleted && !item.dead)) {
    throw invalidResponse("Hacker News item identity does not match its request");
  }
  return item;
}

export function createHnClient(options: ApiOptions): HnClient {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const get = async (path: string, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const request = new Request(`${API}${path}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      redirect: "manual",
      signal,
    });
    const response = await options.fetch(request);
    checkManualResponse(request, response, "HOST_NOT_ALLOWED");
    if (response.status !== 200) {
      rejectStatus(response);
    }
    return readJson(response, MAX_JSON_BYTES, signal);
  };

  return {
    listTopStoryIds: () =>
      withDeadline(
        async (signal) => parseUpstream(ItemIds, await get("/topstories.json", signal)),
        timeoutMs,
      ),
    getStory: (id) =>
      withDeadline(async (signal) => {
        const raw = await get(itemPath(id), signal);
        const item = inspectItem(raw, id);
        if (
          item === null ||
          item.deleted ||
          item.dead ||
          (item.type !== "story" && item.type !== "job" && item.type !== "poll")
        ) {
          return null;
        }
        const fields = parseUpstream(StoryFields, raw);
        return parseUpstream(HnStorySchema, {
          id,
          type: item.type,
          title: fields.title,
          url: fields.url || null,
          text: fields.text ?? null,
          author: fields.by ?? null,
          points: fields.score,
          comments: fields.descendants,
          published_at: fields.time * 1_000,
          deleted: item.deleted,
          dead: item.dead,
        });
      }, timeoutMs),
    getCommentTree: (storyId) =>
      withDeadline(async (signal) => {
        const root = inspectItem(await get(itemPath(storyId), signal), storyId);
        const comments: HnComment[] = [];
        if (
          root === null ||
          root.deleted ||
          root.dead ||
          (root.type !== "story" && root.type !== "poll" && root.type !== "job")
        ) {
          return { story_id: storyId, comments };
        }

        const seen = new Set([storyId]);
        const queue: CommentNode[] = [];
        const enqueue = (
          ids: readonly number[],
          parentId: number,
          depth: number,
          limit: number,
        ) => {
          const nodes: CommentNode[] = [];
          for (const id of ids) {
            if (nodes.length === limit || queue.length === MAX_COMMENT_REQUESTS) {
              break;
            }
            if (!seen.has(id)) {
              seen.add(id);
              const node = { id, parentId, depth, children: [] };
              nodes.push(node);
              queue.push(node);
            }
          }
          return nodes;
        };
        const roots = enqueue(root.kids, storyId, 0, MAX_TOP_LEVEL_COMMENTS);
        for (const node of queue) {
          const raw = await get(itemPath(node.id), signal);
          const item = inspectItem(raw, node.id);
          if (item === null) {
            continue;
          }
          if (item.type !== "comment" && item.type !== undefined) {
            throw invalidResponse("Hacker News comment tree contains a non-comment item");
          }
          if (!item.dead && !item.deleted) {
            const fields = parseUpstream(CommentFields, raw);
            if (fields.parent !== node.parentId) {
              throw invalidResponse("Hacker News comment parent does not match its tree");
            }
            node.comment = {
              id: node.id,
              parent_id: node.parentId,
              depth: node.depth,
              author: fields.by ?? null,
              text: fields.text.slice(0, MAX_COMMENT_CHARS),
              published_at: fields.time * 1_000,
            };
          }
          if (node.depth < MAX_COMMENT_DEPTH) {
            node.children.push(
              ...enqueue(item.kids, node.id, node.depth + 1, MAX_COMMENT_REQUESTS),
            );
          }
        }
        const append = (nodes: readonly CommentNode[]): void => {
          for (const node of nodes) {
            if (node.comment !== undefined) {
              comments.push(node.comment);
            }
            append(node.children);
          }
        };
        append(roots);
        return { story_id: storyId, comments };
      }, timeoutMs),
  };
}
