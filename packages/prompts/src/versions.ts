export const PROMPT_VERSIONS = {
  triage: "triage-v1",
  deep: "deep-v11",
  polish: "polish-v2",
  translate: "translate-v1",
} as const;

// Submissions version their deep prompt on their own, so changing it never invalidates the stored
// deep analyses that HN and changelog items replay from.
export const SUBMISSION_DEEP_PROMPT_VERSION = "deep-submission-v1";

// A submission in `score` mode is reviewed by this prompt instead of the changelog triage prompt,
// so changing either never invalidates the other's stored analyses.
export const SUBMISSION_REVIEW_PROMPT_VERSION = "submission-review-v3";

export const HN_RELEVANCE_PROMPT_VERSION = "hn-relevance-v5";
