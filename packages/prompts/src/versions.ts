export const PROMPT_VERSIONS = {
  triage: "triage-v1",
  deep: "deep-v11",
  polish: "polish-v2",
  translate: "translate-v1",
} as const;

// Submissions version their deep prompt on their own, so changing it never invalidates the stored
// deep analyses that HN and changelog items replay from.
export const SUBMISSION_DEEP_PROMPT_VERSION = "deep-submission-v1";

// A submission in `score` mode is reviewed by this prompt. It is versioned apart from `triage`,
// the key of the retired changelog triage prompt whose stored analyses are still read.
export const SUBMISSION_REVIEW_PROMPT_VERSION = "submission-review-v4";

export const HN_RELEVANCE_PROMPT_VERSION = "hn-relevance-v6";
