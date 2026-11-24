import { AppConfigSchema } from "@ai-moves/contracts/config";
import {
  DestinationPatchSchema,
  DestinationSummarySchema,
  type DestinationSummary,
} from "@ai-moves/contracts/ports/storage";
import type { LocalePack } from "@ai-moves/locales/types";

import type { Configuration, DeskApi } from "./api.ts";
import { dateLabel, element, humanize } from "./dom.ts";

function checkbox(title: string, checked: boolean): [HTMLInputElement, HTMLLabelElement] {
  const input = element("input", { type: "checkbox" });
  input.checked = checked;
  return [input, element("label", { class: "check" }, input, title)];
}

function select(
  title: string,
  choices: Record<string, string>,
  current: string,
): [HTMLSelectElement, HTMLLabelElement] {
  const input = element(
    "select",
    {},
    ...Object.entries(choices).map(([value, label]) => element("option", { value }, label)),
  );
  input.value = current;
  return [input, element("label", {}, title, input)];
}

function destinationForm(
  api: DeskApi,
  destination: DestinationSummary,
  errors: LocalePack["desk"]["errors"],
): HTMLFormElement {
  let current = destination;
  const [enabled, enabledField] = checkbox("Enabled", current.enabled);
  const [dryRun, dryRunField] = checkbox("Dry run", current.dry_run);
  const [hn, hnField] = checkbox("Hacker News", current.source_filters.hn);
  const [changelog, changelogField] = checkbox("Changelogs", current.source_filters.changelog);
  const [language, languageField] = select(
    "Language",
    { en: "English", "zh-CN": "Simplified Chinese", ja: "Japanese" },
    current.lang,
  );
  const [tier, tierField] = select(
    "Minimum tier",
    { "1": "Tier 1", "2": "Tier 2", "3": "Tier 3" },
    String(current.min_tier),
  );
  const budget = element("input", {
    type: "number",
    min: "0",
    step: "1",
    value: String(current.daily_budget),
    required: "",
  });
  const [quiet, quietField] = checkbox("Set quiet hours", current.quiet_hours !== null);
  const start = element("input", {
    type: "time",
    value: current.quiet_hours?.start ?? "23:00",
    required: "",
  });
  const end = element("input", {
    type: "time",
    value: current.quiet_hours?.end ?? "07:00",
    required: "",
  });
  const zone = element("input", {
    type: "text",
    value: current.quiet_hours?.timezone ?? "UTC",
    required: "",
  });
  const quietFields = element(
    "fieldset",
    { class: "fields" },
    element("legend", {}, "Quiet hours"),
    element("label", {}, "Start", start),
    element("label", {}, "End", end),
    element("label", {}, "Time zone (IANA)", zone),
  );
  quietFields.disabled = !quiet.checked;
  quietFields.hidden = !quiet.checked;
  quiet.addEventListener("change", () => {
    quietFields.disabled = !quiet.checked;
    quietFields.hidden = !quiet.checked;
  });
  const status = element("span", { role: "status" });
  const save = element("button", { type: "submit" }, "Save destination");
  const form = element(
    "form",
    { class: "panel" },
    element("h3", {}, destination.name),
    element(
      "p",
      { class: "source" },
      `${humanize(destination.channel)} / ${humanize(destination.purpose)}`,
    ),
    element(
      "div",
      { class: "fields" },
      languageField,
      tierField,
      element("label", {}, "Daily limit", budget),
    ),
    element("div", { class: "checks" }, enabledField, dryRunField, quietField),
    element(
      "fieldset",
      { class: "checks" },
      element("legend", {}, "Sources"),
      hnField,
      changelogField,
    ),
    quietFields,
    element("div", { class: "actions" }, save, status),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!save.disabled)
      void saveDestination().finally(() => {
        save.disabled = false;
      });
  });

  async function saveDestination(): Promise<void> {
    const quietHours = quiet.checked
      ? { start: start.value, end: end.value, timezone: zone.value.trim() }
      : null;
    const sourceFilters = { hn: hn.checked, changelog: changelog.checked };
    const patch = {
      ...(enabled.checked === current.enabled ? {} : { enabled: enabled.checked }),
      ...(dryRun.checked === current.dry_run ? {} : { dry_run: dryRun.checked }),
      ...(language.value === current.lang ? {} : { lang: language.value }),
      ...(Number(tier.value) === current.min_tier ? {} : { min_tier: Number(tier.value) }),
      ...(budget.valueAsNumber === current.daily_budget
        ? {}
        : { daily_budget: budget.valueAsNumber }),
      ...(sourceFilters.hn === current.source_filters.hn &&
      sourceFilters.changelog === current.source_filters.changelog
        ? {}
        : { source_filters: sourceFilters }),
      ...(JSON.stringify(quietHours) === JSON.stringify(current.quiet_hours)
        ? {}
        : { quiet_hours: quietHours }),
    };
    if (Object.keys(patch).length === 0) {
      status.textContent = "No changes to save.";
      return;
    }
    const validated = DestinationPatchSchema.safeParse(patch);
    if (!validated.success) {
      status.textContent =
        "Check the destination settings, including the time zone and daily limit.";
      return;
    }
    save.disabled = true;
    status.textContent = "Saving…";
    const result = await api.saveDestination(current.id, validated.data);
    if (result.ok) current = DestinationSummarySchema.parse({ ...current, ...validated.data });
    status.textContent = result.ok ? "Destination saved." : errors[result.code];
  }
  return form;
}

function configForm(api: DeskApi, current: Configuration, locale: LocalePack): HTMLFormElement {
  let version = current?.version ?? 0;
  const summary = element("p", { class: "source" });
  const editor = element("textarea", { rows: "16", spellcheck: "false", required: "" });
  const status = element("span", { role: "status" });
  const publish = element("button", { type: "submit" }, "Publish configuration");
  const form = element(
    "form",
    { class: "panel" },
    summary,
    element("label", {}, "Configuration JSON", editor),
    element("div", { class: "actions" }, publish, status),
  );
  update(current);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!publish.disabled)
      void publishConfig().finally(() => {
        publish.disabled = false;
      });
  });

  async function publishConfig(): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(editor.value);
    } catch {
      status.textContent = "Enter valid JSON before publishing.";
      return;
    }
    const config = AppConfigSchema.safeParse(input);
    if (!config.success) {
      const field = config.error.issues[0]?.path.join(".");
      status.textContent = field
        ? `Check the value for ${field}.`
        : "Check the configuration format.";
      return;
    }
    publish.disabled = true;
    status.textContent = "Publishing…";
    const result = await api.publish(version, config.data);
    if (result.ok) update(result.value.current);
    status.textContent = result.ok
      ? `Version ${version} published.`
      : locale.desk.errors[result.code];
  }

  function update(value: Configuration): void {
    version = value?.version ?? 0;
    editor.value = value === null ? "" : JSON.stringify(value.config, null, 2);
    summary.replaceChildren(
      ...(value === null
        ? ["No configuration published. Enter a complete configuration to publish version 1."]
        : [`Version ${value.version} published `, dateLabel(value.created_at, locale.dateLocale)]),
    );
  }
  return form;
}

export function adminView(
  api: DeskApi,
  destinations: readonly DestinationSummary[],
  configuration: Configuration,
  locale: LocalePack,
): HTMLElement {
  return element(
    "section",
    { class: "reading" },
    element(
      "header",
      { class: "reading-header" },
      element("h1", {}, "Controls"),
      element(
        "p",
        { class: "lede" },
        "Manage notification destinations and publish versioned settings. Changes are audited.",
      ),
    ),
    element(
      "section",
      {},
      element("h2", {}, "Destinations"),
      ...(destinations.length === 0
        ? [element("p", { class: "notice" }, "No destinations are configured.")]
        : destinations.map((destination) => destinationForm(api, destination, locale.desk.errors))),
    ),
    element(
      "section",
      {},
      element("h2", {}, "Configuration"),
      configForm(api, configuration, locale),
    ),
  );
}
