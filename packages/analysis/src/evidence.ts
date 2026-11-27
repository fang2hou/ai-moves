import { CitationSchema, type Citation } from "@ai-moves/contracts/analysis";
import type { Item, Source } from "@ai-moves/contracts/entities";
import type { HnClient, WebFetcher } from "@ai-moves/contracts/ports/sources";
import type { BlobStore, ItemRevisionRepo } from "@ai-moves/contracts/ports/storage";
import { HttpUrlSchema, HttpsUrlSchema } from "@ai-moves/contracts/primitives";
import { ItemScoreSchema } from "@ai-moves/contracts/scoring";
import { AppError, toAppError } from "@ai-moves/kernel/errors/app-error";
import { hasPublicLinkText, publicLink } from "@ai-moves/kernel/public-links";
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

// Carried into a refresh so the model updates its own earlier reading instead of
// starting over, and so the comment budget goes to comments it has not seen.
export const PriorReadingSchema = z.strictObject({
  summary: z.string().min(1),
  key_points: z.array(z.string()),
  community_view: z.string().nullable(),
  comment_ids: z.array(z.string()),
});
export type PriorReading = z.infer<typeof PriorReadingSchema>;

export const DeepInputSchema = z.strictObject({
  prior: PriorReadingSchema.nullable().default(null),
  title: z.string(),
  topics: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  sourceUrl: HttpUrlSchema.nullable(),
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
  const body = await deps.blobs.get(revision.blob_key);
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
  prior: PriorReading | null = null,
): Promise<DeepInput> {
  const evidence: Evidence[] = [];
  let remaining = Math.min(MAX_EVIDENCE_CHARS, inputTokens * 3);
  const add = (
    url: string,
    input: string | null,
    commentId: string | null,
    limit: number,
  ): void => {
    const text = input?.slice(0, Math.min(remaining, limit)).trim();
    if (!text) return;
    const locator = publicLink(url);
    if (locator === null) return;
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
      // On a refresh the comments the previous pass already read go last, so the
      // budget is spent on what is new.
      const read = new Set(prior?.comment_ids ?? []);
      const ordered = [
        ...tree.comments.filter((comment) => !read.has(String(comment.id))),
        ...tree.comments.filter((comment) => read.has(String(comment.id))),
      ];
      const seen = new Set<number>();
      for (const comment of ordered) {
        if (remaining === 0 || seen.size === MAX_COMMENTS) break;
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        add(hnLink(comment.id), comment.text, String(comment.id), MAX_COMMENT_CHARS);
      }
    }
  } else if (item.kind === "submission") {
    // The sentinel source row carries no label or fallback URL; the card is about the
    // page the reader pointed at, and its markdown excerpt is the only evidence.
    if (sourceUrl === null) throw new AppError("ROW_INVALID");
    const named = item.score_json?.kind === "submission" ? item.score_json.source_name : null;
    // A label the public-link rules reject would withhold the whole card.
    sourceLabel = named !== null && hasPublicLinkText(named) ? named : hostLabel(sourceUrl);
    add(sourceUrl, await readRevision(deps, item), null, remaining);
  } else {
    const origin = source.config_json;
    if (origin.kind === "github_repo") {
      sourceLabel = `${origin.owner}/${origin.repo}`.slice(0, 128);
      sourceUrl ??= `https://github.com/${origin.owner}/${origin.repo}`;
    } else if (origin.kind === "web_page") {
      sourceLabel = origin.label.slice(0, 128);
      sourceUrl ??= origin.page_url;
    } else {
      throw new AppError("ROW_INVALID");
    }
    add(sourceUrl, await readRevision(deps, item), null, remaining);
  }
  return {
    prior,
    title: item.title,
    topics: [...topics],
    evidence,
    sourceUrl: publicLink(sourceUrl),
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

export interface CitationAudit {
  readonly verified: readonly VerifiedCitation[];
  // A quote whose words are not, in order, in its evidence (formatting aside, see
  // `normalizeForMatch`). One is enough to distrust the reading for delivery, but
  // the rest of the document still reads correctly without it, so the quote is
  // dropped rather than the page.
  readonly rejected: number;
}

export function verifyCitations(
  evidence: readonly Evidence[],
  citations: readonly Citation[],
): CitationAudit {
  const sources = new Map(evidence.map((entry) => [entry.locator, entry]));
  // Each source is normalized at most once, however many quotes cite it.
  const normalizedSources = new Map<string, string>();
  const verified: VerifiedCitation[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const { locator, quote } of citations) {
    const source = sources.get(locator);
    const needle = normalizeForMatch(quote);
    if (source === undefined || publicLink(locator) === null || needle === "") {
      rejected++;
      continue;
    }
    let haystack = normalizedSources.get(locator);
    if (haystack === undefined) {
      haystack = normalizeForMatch(source.text);
      normalizedSources.set(locator, haystack);
    }
    if (!containsWords(haystack, needle)) {
      rejected++;
      continue;
    }
    const key = `${locator}\n${needle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verified.push({ quote, commentId: source.commentId });
  }
  return { verified, rejected };
}

// Scripts written without spaces between words; the space a line wrap leaves
// between two of these characters is dropped. Hangul is space-delimited, so it is
// only exempt from the whole-word check below.
const UNSPACED = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}`;
const UNSPACED_GAP = new RegExp(`(?<=[${UNSPACED}]) (?=[${UNSPACED}])`, "gu");
const BOUNDARY_EXEMPT = new RegExp(`^[${UNSPACED}\\p{Script=Hangul}]$`, "u");
const LIST_MARKER = /^[ \t]*[-*+][ \t]+/gm;
// Emphasis and code markers touch the text on one side only; between two letters or
// digits (`snake_case`, `2*3`) or alone between spaces (`a * b`) they carry meaning.
const MARKER_RUN =
  /(?<![\p{L}\p{N}*_`])[*_`]+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])[*_`]+(?![\p{L}\p{N}*_`])/gu;
// A number (with an attached sign and decimal or thousands separators), a single
// meaning-bearing symbol, or a run of letters and digits.
const TOKEN = /(?<![\p{L}\p{N}])[-+]?\p{N}+(?:[.,]\p{N}+)*|[\p{S}%&#@/\\*_-]|[\p{L}\p{M}\p{N}]+/gu;

// Reduces text to its words and meaningful symbols so formatting cannot decide a
// match while wording and meaning still do. NFKC (full-width forms, ligatures, the
// ellipsis character), invisible format characters dropped, case folded, dash
// variants and U+2212 unified to `-`, quote marks and apostrophes removed, markdown
// list markers and emphasis/code markers removed, `!=` unified with `≠`, a hyphen
// between two letters read as a space. The rest is tokenized: letters and digits form
// words, a sign or decimal separator stays attached to its number, each symbol
// (`+ < = > $ % ~ | - * _` and the like) is its own token, and other punctuation and
// whitespace (including line breaks) only separate tokens. Tokens join with single
// spaces, and the space between two Han/kana characters is removed.
function normalizeForMatch(text: string): string {
  const cleaned = text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/['"\u2018-\u201F]/g, "")
    .replace(/!=/g, "\u2260")
    .replace(LIST_MARKER, "")
    .replace(MARKER_RUN, "")
    .replace(/(?<=\p{L})-(?=\p{L})/gu, " ");
  return (cleaned.match(TOKEN) ?? []).join(" ").replace(UNSPACED_GAP, "");
}

// Substring match that does not start or end inside a token, so "cat" does not match
// "concatenate" and "20" does not match "-20" or "3.20". Edges in unspaced scripts
// and Hangul (which takes particles) need no boundary.
function containsWords(haystack: string, needle: string): boolean {
  const first = needle.charAt(0);
  const last = needle.charAt(needle.length - 1);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (
      isBoundary(first, haystack.charAt(at - 1)) &&
      isBoundary(last, haystack.charAt(at + needle.length))
    ) {
      return true;
    }
  }
  return false;
}

function isBoundary(edge: string, neighbor: string): boolean {
  return (
    neighbor === "" ||
    neighbor === " " ||
    BOUNDARY_EXEMPT.test(edge) ||
    BOUNDARY_EXEMPT.test(neighbor)
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.slice(0, 128);
  } catch {
    throw new AppError("ROW_INVALID");
  }
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
