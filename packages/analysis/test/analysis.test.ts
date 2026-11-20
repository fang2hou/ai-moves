import { AlertDocSchema } from "@ai-moves/contracts/alert-doc";
import { AppError } from "@ai-moves/kernel/errors/app-error";
import { PROMPT_VERSIONS } from "@ai-moves/prompts/versions";
import { describe, expect, it } from "vitest";

import { processDeep } from "../src/deep.ts";
import { processTriage } from "../src/triage.ts";
import {
  assessment,
  deepJob,
  fixture,
  japanese,
  notes,
  pass,
  respond,
  triageJob,
  url,
} from "./fixture.ts";

describe("analysis consumers", () => {
  it("calls triage and wakes deep once for simultaneous jobs in the same millisecond", async () => {
    const f = await fixture({ steps: [respond(pass)] });
    await Promise.all([processTriage(f.deps, triageJob), processTriage(f.deps, triageJob)]);

    expect(f.item().state).toBe("triaged_pass");
    expect(f.jobs.jobs("q-deep")).toEqual([{ ...deepJob, trace_id: triageJob.trace_id }]);
    expect(f.llm.calls.map(([request]) => request.schemaName)).toEqual([PROMPT_VERSIONS.triage]);
    expect(f.receipts).toMatchObject([
      { scope: "ai:triage:repo:example/acme", amount: 1, limit: 3 },
      { scope: "ai:triage", amount: 1 },
    ]);
    expect(new Set(f.receipts.map(({ workId }) => workId)).size).toBe(1);
  });

  it("does not request a receipt or a model without a won analysis lease", async () => {
    const f = await fixture({ steps: [respond(pass)] });
    const deps = {
      ...f.deps,
      analyses: { ...f.deps.analyses, claim: () => Promise.resolve(false) },
    };
    await processTriage(deps, triageJob);

    expect(f.item().state).toBe("triaging");
    expect(f.receipts).toEqual([]);
    expect(f.llm.calls).toEqual([]);
    expect(f.jobs.jobs("q-deep")).toEqual([]);
  });

  it("reuses completed triage after a crash before the item CAS", async () => {
    const f = await fixture({
      steps: [respond(pass)],
      retry: { analysis: { max_queue_retries: 0 } },
    });
    f.interruptTransition("triaged_pass");
    await expect(processTriage(f.deps, triageJob)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    expect([...f.rows.values()]).toMatchObject([{ status: "succeeded", stage: "triage" }]);

    f.clock.advance(f.deps.config.leases.triage_minutes * 60_000 + 1);
    await f.recover("candidate");
    await processTriage(f.deps, triageJob);

    expect(f.item().state).toBe("triaged_pass");
    expect(f.jobs.jobs("q-deep")).toEqual([{ ...deepJob, trace_id: triageJob.trace_id }]);
    expect(f.llm.calls).toHaveLength(1);
    expect(f.receipts.map(({ scope }) => scope)).toEqual([
      "ai:triage:repo:example/acme",
      "ai:triage",
    ]);
  });

  it("cannot publish a result that arrives after replacement and cannot reuse the abandoned debit", async () => {
    const f = await fixture({ steps: [respond(pass)], ai: { triage_items_per_day: 1 } });
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const old = processTriage(
      {
        ...f.deps,
        llm: {
          generateStructured: async (request) => {
            const result = await f.llm.generateStructured(request);
            started.resolve();
            await finished.promise;
            return result;
          },
        },
      },
      triageJob,
    );
    try {
      await started.promise;
      f.clock.advance(f.deps.config.leases.triage_minutes * 60_000 + 1);
      await f.recover("candidate");
      await processTriage(f.deps, triageJob);
    } finally {
      finished.resolve();
      await old;
    }

    expect(f.item().state).toBe("skipped_budget");
    expect([...f.rows.values()]).toMatchObject([
      { status: "failed", error_code: "BUDGET_EXHAUSTED" },
    ]);
    expect(f.jobs.jobs("q-deep")).toEqual([]);
    expect(f.llm.calls).toHaveLength(1);
    expect(f.receipts.map(({ scope }) => scope)).toEqual([
      "ai:triage:repo:example/acme",
      "ai:triage",
      "ai:triage:repo:example/acme",
      "ai:triage",
    ]);
    expect(
      new Set(f.receipts.filter(({ scope }) => scope === "ai:triage").map(({ workId }) => workId))
        .size,
    ).toBe(2);
  });

  it("admits one concurrent source alias at the cap and leaves other repositories and UTC days independent", async () => {
    const changelog = { max_triage_per_repo_per_day: 1 };
    const first = await fixture({
      changelog,
      repository: { owner: "Org", repo: "Named.Project" },
      steps: [respond(pass)],
    });
    const alias = await fixture({
      changelog,
      repository: { owner: "ORG", repo: "named.project" },
      sourceId: "alias",
      itemId: "alias_item",
      steps: [respond(pass)],
    });
    const other = await fixture({
      changelog,
      repository: { owner: "Org", repo: "other" },
      sourceId: "other",
      steps: [respond(pass)],
    });
    const tomorrow = await fixture({
      changelog,
      repository: { owner: "org", repo: "named.project" },
      sourceId: "tomorrow",
      steps: [respond(pass)],
    });
    const { budgets, ids } = first.deps;
    const midnight = Date.parse("2026-11-21T00:00:00Z");
    first.clock.set(midnight - 1);
    alias.clock.set(midnight - 1);
    await Promise.all([
      processTriage(first.deps, triageJob),
      processTriage({ ...alias.deps, budgets, ids }, { ...triageJob, item_id: alias.item().id }),
    ]);
    expect([first.item().state, alias.item().state]).toEqual(
      expect.arrayContaining(["skipped_budget", "triaged_pass"]),
    );
    expect(first.llm.calls.length + alias.llm.calls.length).toBe(1);
    expect(first.receipts.filter(({ scope }) => scope === "ai:triage")).toMatchObject([
      { day: "2026-11-20", amount: 1 },
    ]);
    await processTriage({ ...other.deps, budgets, ids }, triageJob);
    tomorrow.clock.set(midnight);
    await processTriage({ ...tomorrow.deps, budgets, ids }, triageJob);

    expect(other.item().state).toBe("triaged_pass");
    expect(tomorrow.item().state).toBe("triaged_pass");
    expect(
      first.receipts.filter(({ scope }) => scope === "ai:triage:repo:org/named.project"),
    ).toMatchObject([
      { day: "2026-11-20", amount: 1, limit: 1 },
      { day: "2026-11-20", amount: 1, limit: 1 },
      { day: "2026-11-21", amount: 1, limit: 1 },
    ]);
  });

  it("persists retry backoff, caps model invocations and leaves no deep wake-up on failure", async () => {
    const timeout = new AppError("UPSTREAM_TIMEOUT", { retryAfterMs: 900_000 });
    const failure = { kind: "reject", error: timeout } as const;
    const f = await fixture({
      steps: [failure, failure],
      retry: { analysis: { max_queue_retries: 1 } },
    });
    const now = f.clock.now();
    await processTriage(f.deps, triageJob);
    expect(f.item()).toMatchObject({
      state: "candidate",
      attempts: 1,
      next_attempt_at: now + 900_000,
    });
    await processTriage(f.deps, triageJob);
    expect(f.llm.calls).toHaveLength(1);

    f.clock.advance(900_000);
    await processTriage(f.deps, triageJob);
    await processTriage(f.deps, triageJob);
    expect(f.item().state).toBe("failed_analysis");
    expect(f.llm.calls).toHaveLength(2);
    expect(f.jobs.jobs("q-deep")).toEqual([]);
  });

  it("rejects a persisted repository with an invalid canonical identity before debiting", async () => {
    const f = await fixture({ repository: { owner: "bad_owner", repo: "acme" } });
    await processTriage(f.deps, triageJob);

    expect(f.item().state).toBe("failed_analysis");
    expect([...f.rows.values()]).toMatchObject([{ status: "failed", error_code: "ROW_INVALID" }]);
    expect(f.receipts).toEqual([]);
    expect(f.llm.calls).toEqual([]);
  });

  it("does not call deep without a receipt grant", async () => {
    const f = await fixture({ state: "triaged_pass", ai: { deep_per_day: 0 } });
    await processDeep(f.deps, deepJob);
    expect(f.item().state).toBe("feed_only");
    expect(f.llm.calls).toEqual([]);
    expect(f.receipts).toMatchObject([{ scope: "ai:deep", limit: 0 }]);
    expect(f.finalized[0]).toMatchObject({
      alert: { decision: "feed_only", decision_reason_json: { blocked_by: ["budget_exhausted"] } },
      documents: [],
    });
  });

  it.each([
    { locator: "https://invented.example.test", quote: notes },
    { locator: url, quote: "The release no longer permits parallel builds." },
    { locator: url, quote: " " },
  ])("feeds but never prepares a sendable document for invalid citation %#", async (citation) => {
    const f = await fixture({
      state: "triaged_pass",
      steps: [respond({ ...assessment, citations: [citation] })],
    });
    await processDeep(f.deps, deepJob);
    expect(f.item().state).toBe("feed_only");
    expect(f.finalized[0]).toMatchObject({
      alert: {
        decision: "feed_only",
        decision_reason_json: { blocked_by: ["citation_check_failed"] },
      },
      documents: [],
    });
    expect([...f.rows.values()][0]?.output_json).toMatchObject({
      value: { citations: [citation] },
    });
  });

  it("keeps malformed structured output out of final documents", async () => {
    const f = await fixture({
      state: "triaged_pass",
      steps: [respond({ ...assessment, impact: 9 })],
    });
    await processDeep(f.deps, deepJob);
    expect(f.item().state).toBe("feed_only");
    expect([...f.rows.values()]).toMatchObject([
      { status: "failed", error_code: "LLM_OUTPUT_INVALID" },
    ]);
    expect(f.finalized[0]?.documents).toEqual([]);
  });

  it("does not let a valid citation authorize a model-invented link", async () => {
    const f = await fixture({
      state: "triaged_pass",
      steps: [
        respond({ ...assessment, summary: "See https://unrelated.example.test for details." }),
      ],
    });
    await processDeep(f.deps, deepJob);
    expect(f.item().state).toBe("feed_only");
    expect(f.finalized[0]?.documents).toEqual([]);
  });

  it("keeps the English document but blocks a translation that changes a version", async () => {
    const f = await fixture({
      state: "triaged_pass",
      languages: ["en", "ja"],
      steps: [
        respond(assessment),
        respond({ ...japanese, summary: japanese.summary.replace("1.2.3", "2.0.0") }),
      ],
    });
    await processDeep(f.deps, deepJob);
    expect(f.finalized[0]?.documents.map(({ lang }) => lang)).toEqual(["en"]);
    expect([...f.rows.values()].find(({ stage }) => stage === "translate")).toMatchObject({
      lang: "ja",
      status: "failed",
      error_code: "FIDELITY_CHECK_FAILED",
    });
  });

  it("rebuilds identical canonical documents after a crash after alert persistence", async () => {
    const f = await fixture({
      state: "triaged_pass",
      languages: ["ja"],
      steps: [respond(assessment), respond(japanese)],
    });
    f.interruptFinalization();
    await expect(processDeep(f.deps, deepJob)).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    expect(f.item().state).toBe("analyzed");
    const initial = f.finalized[0];
    const english = AlertDocSchema.parse(initial?.documents[0]);
    const translated = AlertDocSchema.parse(initial?.documents[1]);
    expect(translated).toMatchObject({
      alert_id: initial?.alert.id,
      lang: "ja",
      title: { original: english.title.original, translated: japanese.title },
      summary: japanese.summary,
      links: { source: url, discussion: null, detail: "https://feed.example.test/items/item" },
      key_points: [
        { text: japanese.key_points[0], evidence_quote: null },
        { evidence_quote: notes },
      ],
      translation: { machine_translated: true, fell_back_to_english: false },
    });
    expect([...f.rows.values()]).toMatchObject([
      {
        stage: "deep",
        prompt_version: PROMPT_VERSIONS.deep,
        config_version: 3,
        output_json: { value: assessment, model: "fixture-fallback" },
      },
      {
        stage: "translate",
        prompt_version: PROMPT_VERSIONS.translate,
        config_version: 3,
        output_json: { value: japanese },
      },
    ]);
    const deep = [...f.rows.values()].find((row) => row.stage === "deep");
    const persisted = deep?.r2_key ? await f.blobs.get(deep.r2_key) : null;
    expect(
      persisted === null ? null : JSON.parse(new TextDecoder().decode(persisted)),
    ).toMatchObject({
      evidence: [{ locator: url, text: notes }],
    });

    f.clock.advance(120_000);
    await processDeep(f.deps, deepJob);
    expect(f.item().state).toBe("alerted");
    expect(f.finalized[1]?.documents).toEqual(initial?.documents);
    expect(f.finalized[1]?.alert).toEqual(initial?.alert);
    expect(f.alerts.size).toBe(1);
    expect(f.llm.calls).toHaveLength(2);
    expect(f.receipts.map(({ scope }) => scope)).toEqual(["ai:deep", "ai:translate"]);
  });
});
