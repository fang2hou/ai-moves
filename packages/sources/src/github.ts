import { RepoRefSchema, type RepoRef } from "@ai-news-tracker/contracts/entities";
import {
  GitHubCompareSchema,
  GitHubFileSchema,
  GitHubReleaseSchema,
  GitHubTagSchema,
  type Conditional,
  type GitHubClient,
} from "@ai-news-tracker/contracts/ports/sources";
import { NonNegativeIntSchema } from "@ai-news-tracker/contracts/primitives";
import { AppError, isAppError } from "@ai-news-tracker/kernel/errors/app-error";
import { z } from "zod";

import {
  type ApiOptions,
  checkManualResponse,
  discardBody,
  invalidResponse,
  isRedirect,
  parseUpstream,
  readJson,
  redirectLocation,
  rejectStatus,
  USER_AGENT,
  withDeadline,
} from "./http.ts";

const API = "https://api.github.com";
const MAX_REDIRECTS = 3;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const API_VERSION = "2026-03-10";

const Releases = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullable(),
    body: z.string().nullish(),
    prerelease: z.boolean(),
    draft: z.boolean(),
    published_at: z.iso.datetime({ offset: true }).nullable(),
    html_url: z.string(),
  }),
);
const Tags = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) }));
const FileKind = z.object({ type: z.string(), encoding: z.string().optional() });
const File = z.object({
  path: z.string(),
  sha: z.string(),
  content: z.string(),
  size: NonNegativeIntSchema,
});
const Compare = z.object({
  commits: z.array(z.object({ commit: z.object({ message: z.string() }) })),
  html_url: z.string(),
});
const ApiError = z.object({ message: z.string() });

export interface GitHubClientOptions extends ApiOptions {
  readonly token?: string;
}

function repoPath(repo: RepoRef): string {
  const checked = RepoRefSchema.safeParse(repo);
  if (
    !checked.success ||
    [checked.data.owner, checked.data.repo].some((part) => part === "." || part === "..")
  ) {
    throw new AppError("INPUT_INVALID", { message: "Invalid GitHub repository" });
  }
  return `/repos/${checked.data.owner}/${checked.data.repo}`;
}

function filePath(path: string): string {
  const segments = path.split("/");
  if (
    !path.isWellFormed() ||
    path.includes("\\") ||
    segments.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new AppError("INPUT_INVALID", { message: "Invalid GitHub file path" });
  }
  return segments.map(encodeURIComponent).join("/");
}

function compareRef(ref: string): string {
  if (
    ref.trim() === "" ||
    !ref.isWellFormed() ||
    ref.includes("..") ||
    ref.startsWith(".") ||
    ref.endsWith(".")
  ) {
    throw new AppError("INPUT_INVALID", { message: "Invalid GitHub comparison ref" });
  }
  return encodeURIComponent(ref);
}

function headersFor(token: string | undefined, etag: string | null): Headers {
  try {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION,
    });
    if (token !== undefined) {
      headers.set("authorization", `Bearer ${token}`);
    }
    if (etag !== null) {
      headers.set("if-none-match", etag);
    }
    return headers;
  } catch {
    throw new AppError("INPUT_INVALID", { message: "Invalid GitHub request headers" });
  }
}

function fileText(input: unknown, path: string) {
  if (Array.isArray(input)) {
    throw new AppError("CONTENT_UNSUPPORTED", { message: "GitHub path is a directory" });
  }
  const kind = parseUpstream(FileKind, input);
  if (kind.type !== "file" || kind.encoding === "none") {
    throw new AppError("CONTENT_UNSUPPORTED", { message: "GitHub path is not an inline file" });
  }
  if (kind.encoding !== "base64") {
    throw invalidResponse("GitHub file encoding is invalid");
  }
  const file = parseUpstream(File, input);
  if (file.path !== path) {
    throw invalidResponse("GitHub file path does not match its request");
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
  } catch {
    throw invalidResponse("GitHub file body is not base64");
  }
  if (bytes.byteLength !== file.size) {
    throw invalidResponse("GitHub file size does not match its body");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError("CONTENT_UNSUPPORTED", { message: "GitHub file is not UTF-8 text" });
  }
  return parseUpstream(GitHubFileSchema, { path, sha: file.sha, text });
}

async function isRateLimited(response: Response, signal: AbortSignal): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  if (
    response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    return true;
  }
  try {
    const warning = ApiError.safeParse(await readJson(response, MAX_ERROR_BYTES, signal));
    return warning.success && /\bsecondary rate limit\b/i.test(warning.data.message);
  } catch (error) {
    if (isAppError(error) && error.code === "UPSTREAM_RESPONSE_INVALID") {
      return false;
    }
    throw error;
  }
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const timeoutMs = options.timeoutMs ?? 10_000;

  const get = async (path: string, etag: string | null, signal: AbortSignal): Promise<Response> => {
    const headers = headersFor(options.token, etag);
    let url = new URL(path, API);
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const request = new Request(url, { headers, redirect: "manual", signal });
      const response = await options.fetch(request);
      checkManualResponse(request, response, "HOST_NOT_ALLOWED");
      if (!isRedirect(response)) {
        return response;
      }
      const location = redirectLocation(response);
      if (redirects === MAX_REDIRECTS) {
        throw new AppError("UPSTREAM_REJECTED", { message: "GitHub redirect limit exceeded" });
      }
      const target = URL.parse(location, url);
      if (target === null) {
        throw invalidResponse("GitHub redirect URL is invalid");
      }
      if (target.origin !== API || target.username !== "" || target.password !== "") {
        throw new AppError("HOST_NOT_ALLOWED", { message: "GitHub redirect left the API origin" });
      }
      target.hash = "";
      url = target;
    }
  };

  const conditional = <Value>(
    path: () => string,
    etag: string | null,
    parse: (input: unknown) => Value,
    absent?: { readonly value: Value },
  ): Promise<Conditional<Value>> =>
    withDeadline(async (signal): Promise<Conditional<Value>> => {
      const response = await get(path(), etag, signal);
      if (response.status === 304) {
        discardBody(response);
        if (etag === null) {
          throw invalidResponse("GitHub returned 304 without an ETag precondition");
        }
        return { status: "not_modified" };
      }
      if (response.status === 404 && absent !== undefined) {
        discardBody(response);
        return { status: "modified", etag: null, value: absent.value };
      }
      if (response.status !== 200) {
        rejectStatus(response, await isRateLimited(response, signal));
      }
      return {
        status: "modified",
        etag: response.headers.get("etag"),
        value: parse(await readJson(response, MAX_JSON_BYTES, signal)),
      };
    }, timeoutMs);

  return {
    listReleases: (repo, { etag }) =>
      conditional(
        () => `${repoPath(repo)}/releases?per_page=10`,
        etag,
        (input) =>
          parseUpstream(Releases, input).map((release) =>
            parseUpstream(GitHubReleaseSchema, {
              tag: release.tag_name,
              name: release.name,
              body: release.body ?? null,
              prerelease: release.prerelease,
              draft: release.draft,
              published_at: release.published_at === null ? null : Date.parse(release.published_at),
              url: release.html_url,
            }),
          ),
      ),
    listTags: (repo, { etag }) =>
      conditional(
        () => `${repoPath(repo)}/tags?per_page=10`,
        etag,
        (input) =>
          parseUpstream(Tags, input).map(({ name, commit }) =>
            parseUpstream(GitHubTagSchema, { name, commit_sha: commit.sha }),
          ),
      ),
    getFile: (repo, path, { etag }) =>
      conditional(
        () => `${repoPath(repo)}/contents/${filePath(path)}`,
        etag,
        (input) => fileText(input, path),
        { value: null },
      ),
    compare: (repo, base, head) =>
      withDeadline(async (signal) => {
        const path = `${repoPath(repo)}/compare/${compareRef(base)}...${compareRef(head)}`;
        const response = await get(path, null, signal);
        if (response.status !== 200) {
          rejectStatus(response, await isRateLimited(response, signal));
        }
        const compared = parseUpstream(Compare, await readJson(response, MAX_JSON_BYTES, signal));
        return parseUpstream(GitHubCompareSchema, {
          base,
          head,
          url: compared.html_url,
          commit_messages: compared.commits.map(({ commit }) => commit.message),
        });
      }, timeoutMs),
  };
}
