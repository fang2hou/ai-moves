import { BudgetScopeSchema, changelogTriageBudgetScope } from "@ai-moves/contracts/entities";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("changelog triage budget scope", () => {
  it("canonicalizes GitHub case without collapsing distinct repository punctuation", () => {
    const scope = changelogTriageBudgetScope({ owner: "Example-Org", repo: "SDK_JS.v2" });
    expect(scope).toBe("ai:triage:repo:example-org/sdk_js.v2");
    expect(changelogTriageBudgetScope({ owner: "example-org", repo: "sdk_js.v2" })).toBe(scope);
    expect(changelogTriageBudgetScope({ owner: "example-org", repo: "sdk-js.v2" })).not.toBe(scope);
    expect(BudgetScopeSchema.safeParse("ai:triage:repo:Example-Org/sdk_js.v2").success).toBe(false);
  });

  it("accepts maximum-length owner and repository names without truncating either", () => {
    const owner = "a".repeat(39);
    const repo = "b".repeat(100);
    expect(changelogTriageBudgetScope({ owner, repo })).toBe(`ai:triage:repo:${owner}/${repo}`);
  });

  it.each([
    { owner: "", repo: "lib" },
    { owner: "team--name", repo: "lib" },
    { owner: "-team", repo: "lib" },
    { owner: "team-", repo: "lib" },
    { owner: "team_org", repo: "lib" },
    { owner: "a".repeat(40), repo: "lib" },
    { owner: "team", repo: "" },
    { owner: "team", repo: "." },
    { owner: "team", repo: ".." },
    { owner: "team", repo: "lib.git" },
    { owner: "team", repo: "lib/other" },
    { owner: "team", repo: "lib%2fother" },
    { owner: "team", repo: "lib\n" },
    { owner: "team", repo: "Kit" },
    { owner: "team", repo: "b".repeat(101) },
  ])("rejects invalid repository identity $owner/$repo", ({ owner, repo }) => {
    expect(() => changelogTriageBudgetScope({ owner, repo })).toThrow(ZodError);
    expect(BudgetScopeSchema.safeParse(`ai:triage:repo:${owner}/${repo}`).success).toBe(false);
  });
});
