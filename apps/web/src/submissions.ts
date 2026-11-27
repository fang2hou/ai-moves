import type { SubmissionList, SubmissionSummary } from "@ai-moves/contracts/submission";
import type { LocalePack, SubmissionBadge } from "@ai-moves/locales/types";

import { dateLabel, element } from "./dom.ts";
import type { CallResult, SubmissionsApi } from "./mcp.ts";
import { sourceName } from "./source.ts";

// A submitted URL is reader-supplied text; only web links become anchors.
function webUrl(value: string | null): string | null {
  const parsed = value === null ? null : URL.parse(value);
  return parsed?.protocol === "https:" || parsed?.protocol === "http:" ? value : null;
}

function badgeOf({ state, forced_by, alert }: SubmissionSummary): SubmissionBadge {
  switch (state) {
    // A send decision is not a send: only a delivery that reached a destination counts.
    case "alerted":
      return alert?.delivery === "sent" ? "sent" : "published";
    case "feed_only":
    case "archived":
      return "published";
    case "failed_analysis":
      return "failed";
    case "triaged_reject":
    case "skipped_trivial":
    case "skipped_budget":
      return "rejected";
    case "discovered":
    case "tracking":
    case "candidate":
    case "triaging":
    case "triaged_pass":
    case "analyzing":
    case "analyzed":
      break;
  }
  // A forced item is on its way to deep analysis and sending; the badge says why.
  return forced_by === null ? "in_review" : "forced";
}

export function submissionsView(
  list: SubmissionList,
  api: SubmissionsApi,
  { desk, dateLocale }: LocalePack,
): HTMLElement {
  const copy = desk.submissions;

  function row(summary: SubmissionSummary): HTMLElement {
    const item = element("li", { class: "sub" });
    const badge = badgeOf(summary);
    const published = summary.state === "alerted" || summary.state === "feed_only";
    const href = published ? summary.detail_url : webUrl(summary.url);
    const origin =
      summary.source_name ?? (summary.url === null ? "" : sourceName("submission", summary.url));

    item.append(
      element(
        "div",
        { class: "sub-head" },
        href === null
          ? element("span", { class: "sub-title" }, summary.title)
          : element("a", { class: "sub-title", href }, summary.title),
        element("span", { class: `badge badge-${badge}` }, copy.badges[badge]),
      ),
      element(
        "p",
        { class: "sub-meta" },
        ...(origin === "" ? [] : [element("span", { class: "sub-origin" }, origin)]),
        element("span", {}, `${copy.submittedBy} `, element("b", {}, summary.submitted_by)),
        dateLabel(summary.submitted_at, dateLocale),
        ...(summary.forced_by === null
          ? []
          : [element("span", {}, `${copy.forcedBy} `, element("b", {}, summary.forced_by))]),
      ),
      reviewBlock(summary),
    );

    const foot = element("div", { class: "sub-foot" });
    if (summary.alert !== null) foot.append(alertLine(summary.alert));
    if (summary.can_rereview) foot.append(rereviewButton(summary, item));
    if (summary.can_force) foot.append(forceButton(summary, item));
    if (foot.childNodes.length > 0) item.append(foot);
    return item;
  }

  // The verdict is what a reader scans for: the score as a large number, the one-line reason
  // right under it.
  function reviewBlock({ review, mode }: SubmissionSummary): HTMLElement {
    if (review === null) {
      // `publish` skips the reviewer, so there is nothing to wait for.
      const text = mode === "publish" ? copy.notReviewed : copy.awaitingReview;
      return element("p", { class: "review-pending" }, text);
    }
    return element(
      "div",
      { class: `review review-${review.decision}` },
      element(
        "p",
        { class: "review-head" },
        element(
          "span",
          { class: "review-score" },
          review.score === null ? "–" : String(review.score),
        ),
        element("span", { class: "tag" }, copy.decisions[review.decision]),
      ),
      element("p", { class: "review-comment" }, review.comment),
    );
  }

  function alertLine(alert: NonNullable<SubmissionSummary["alert"]>): HTMLElement {
    const text =
      alert.decision !== "send"
        ? copy.formatAlertNotSent(alert.blocked_by.map((reason) => copy.blockReasons[reason]))
        : copy.deliveryStatus[alert.delivery];
    return element("p", { class: "sub-alert" }, text);
  }

  function forceButton(summary: SubmissionSummary, item: HTMLElement): HTMLButtonElement {
    return actionButton(item, {
      label: copy.force,
      busy: copy.forcing,
      confirmText: copy.formatConfirmForce(summary.title),
      run: () => api.force(summary.item_id),
    });
  }

  function rereviewButton(summary: SubmissionSummary, item: HTMLElement): HTMLButtonElement {
    return actionButton(item, {
      label: copy.rereview,
      busy: copy.rereviewing,
      confirmText: copy.formatConfirmRereview(summary.title),
      run: () => api.rereview(summary.item_id),
    });
  }

  // Confirms, runs the tool, and replaces the row with the summary the tool returns.
  function actionButton(
    item: HTMLElement,
    action: {
      readonly label: string;
      readonly busy: string;
      readonly confirmText: string;
      readonly run: () => Promise<CallResult<SubmissionSummary>>;
    },
  ): HTMLButtonElement {
    const button = element("button", { type: "button", class: "force" }, action.label);
    button.addEventListener("click", () => void click());
    return button;

    async function click(): Promise<void> {
      if (!confirm(action.confirmText)) return;
      button.disabled = true;
      button.textContent = action.busy;
      const result = await action.run();
      if (result.ok) {
        item.replaceWith(row(result.value));
        return;
      }
      button.disabled = false;
      button.textContent = action.label;
      item.querySelector(".sub-error")?.remove();
      item.append(
        element("p", { class: "notice sub-error", role: "alert" }, copy.errors[result.code]),
      );
    }
  }

  return element(
    "section",
    { class: "subs" },
    element("h1", {}, copy.title),
    list.submissions.length === 0
      ? element("p", { class: "notice" }, copy.empty)
      : element("ul", { class: "sub-list" }, ...list.submissions.map(row)),
  );
}
