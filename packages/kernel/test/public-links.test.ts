import { expect, it } from "vitest";

import { publicLink } from "../src/public-links.ts";

it("keeps compatible links unchanged rather than reserializing them", () => {
  expect(publicLink("https://example.test")).toBe("https://example.test");
  expect(publicLink("https://example.test#intro")).toBe("https://example.test");
});

it.each([
  "https://reader@example.test/story",
  "https://@example.test/story",
  "https://example.test/item?id=7",
  "https://news.ycombinator.com/from?id=7",
  "https://news.ycombinator.com/item?id=7&id=8",
  "https://news.ycombinator.com/item?id=7&edition=sample",
  "https://news.ycombinator.com/item?id=sample",
])("withholds a link outside the narrow publication policy (%s)", (input) => {
  expect(publicLink(input)).toBeNull();
});
