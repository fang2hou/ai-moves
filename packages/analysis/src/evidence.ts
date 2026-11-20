import { CitationSchema, type Citation } from "@ai-moves/contracts/analysis";
import type { Item, Source } from "@ai-moves/contracts/entities";
import type { HnClient, WebFetcher } from "@ai-moves/contracts/ports/sources";
import type { BlobStore, ItemRevisionRepo } from "@ai-moves/contracts/ports/storage";
import { HttpUrlSchema, HttpsUrlSchema } from "@ai-moves/contracts/primitives";
import { ItemScoreSchema } from "@ai-moves/contracts/scoring";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { z } from "zod";

const MAX_EVIDENCE_CHARS = 48_000;
const MAX_COMMENTS = 16;
const MAX_COMMENT_CHARS = 1500;

const evidenceSchema = z.strictObject({
  locator: CitationSchema.shape.locator,
  text: z.string().min(1).max(MAX_EVIDENCE_CHARS),
  commentId: z.string().nullable(),
});
type Evidence = z.infer<typeof evidenceSchema>;

export const DeepInputSchema = z.strictObject({
  title: z.string(),
  topics: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  sourceUrl: HttpUrlSchema,
  discussion: HttpsUrlSchema.nullable(),
  sourceLabel: z.string(),
  score: ItemScoreSchema.nullable(),
  blocked: z.boolean(),
});
export type DeepInput = z.infer<typeof DeepInputSchema>;

export interface RevisionEvidenceDependencies {
  readonly revisions: Pick<ItemRevisionRepo, "listByItem">;
  readonly blobs: Pick<BlobStore, "get">;
}

export interface EvidenceDependencies extends RevisionEvidenceDependencies {
  readonly hn: Pick<HnClient, "getStory" | "getCommentTree">;
  readonly web: WebFetcher;
}

export async function readRevision(
  deps: RevisionEvidenceDependencies,
  item: Item,
): Promise<string | null> {
  if (item.content_hash === null) return null;
  const revision = (await deps.revisions.listByItem(item.id)).find(
    (entry) => entry.content_hash === item.content_hash,
  );
  if (revision === undefined) {
    throw new AppError("STORAGE_UNAVAILABLE", { message: "Missing current item revision" });
  }
  const body = await deps.blobs.get(revision.r2_key);
  if (body === null)
    throw new AppError("STORAGE_UNAVAILABLE", { message: "Missing revision blob" });
  return new TextDecoder().decode(body);
}

export async function collectEvidence(
  deps: EvidenceDependencies,
  item: Item,
  source: Source,
  topics: readonly string[],
  inputTokens: number,
): Promise<DeepInput> {
  const evidence: Evidence[] = [];
  let remaining = Math.min(MAX_EVIDENCE_CHARS, inputTokens * 3);
  const add = (
    locator: string,
    input: string | null,
    commentId: string | null,
    limit: number,
  ): void => {
    const text = input?.slice(0, Math.min(remaining, limit)).trim();
    if (!text) return;
    evidence.push({ locator, text, commentId });
    remaining -= text.length;
  };

  let discussion: string | null = null;
  let sourceUrl = item.url;
  let sourceLabel = "Hacker News";
  let blocked = false;
  if (item.kind === "hn") {
    const match = /^hn:(\d+)$/u.exec(item.external_key);
    const storyId = Number(match?.[1]);
    if (!Number.isSafeInteger(storyId) || storyId <= 0) throw new AppError("ROW_INVALID");
    discussion = hnLink(storyId);
    const articleUrl = sourceUrl ?? discussion;
    sourceUrl = articleUrl;
    const sourceLimit = Math.ceil(remaining * 0.75);
    try {
      if (sourceUrl === discussion) {
        const story = await optionalEvidence(() => deps.hn.getStory(storyId));
        if (story?.id === storyId && !story.dead && !story.deleted) {
          add(discussion, story.text, null, sourceLimit);
        }
      } else {
        const document = await optionalEvidence(() => deps.web.fetchText(articleUrl));
        if (document !== null) add(document.final_url, document.text, null, sourceLimit);
      }
    } catch (cause) {
      const error = toAppError(cause);
      if (error.kind !== "security") throw error;
      blocked = true;
    }
    const tree = blocked ? null : await optionalEvidence(() => deps.hn.getCommentTree(storyId));
    if (tree?.story_id === storyId) {
      const seen = new Set<number>();
      for (const comment of tree.comments) {
        if (remaining === 0 || seen.size === MAX_COMMENTS) break;
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        add(hnLink(comment.id), comment.text, String(comment.id), MAX_COMMENT_CHARS);
      }
    }
  } else {
    if (source.config_json.kind !== "github_repo") throw new AppError("ROW_INVALID");
    sourceLabel = `${source.config_json.owner}/${source.config_json.repo}`.slice(0, 128);
    sourceUrl ??= `https://github.com/${source.config_json.owner}/${source.config_json.repo}`;
    add(sourceUrl, await readRevision(deps, item), null, remaining);
  }
  return {
    title: item.title,
    topics: [...topics],
    evidence,
    sourceUrl,
    discussion,
    sourceLabel,
    score: item.score_json,
    blocked,
  };
}

export interface VerifiedCitation {
  readonly quote: string;
  readonly commentId: string | null;
}

export function verifyCitations(
  evidence: readonly Evidence[],
  citations: readonly Citation[],
): readonly VerifiedCitation[] | null {
  if (citations.length === 0) return null;
  const sources = new Map(evidence.map((entry) => [entry.locator, entry]));
  const verified: VerifiedCitation[] = [];
  const seen = new Set<string>();
  for (const { locator, quote } of citations) {
    const source = sources.get(locator);
    if (source === undefined || quote.trim() === "" || !source.text.includes(quote)) return null;
    const key = `${locator}\n${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push({ quote, commentId: source.commentId });
  }
  return verified;
}

function hnLink(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`;
}

async function optionalEvidence<T>(fetchEvidence: () => Promise<T>): Promise<T | null> {
  try {
    return await fetchEvidence();
  } catch (cause) {
    const error = toAppError(cause);
    if (error.kind === "permanent" || error.kind === "validation") {
      return null;
    }
    throw error;
  }
}
