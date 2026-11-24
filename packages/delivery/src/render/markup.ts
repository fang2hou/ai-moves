// Text clean-up shared by the channel renderers. Each channel escapes its own markup;
// these helpers only normalise what the model wrote.

// Inline code is the one piece of markup the writing allows.
export const CODE_SPAN = /`([^`\n]{1,200})`/gu;

export function withoutCodeMarks(input: string): string {
  return input.replace(CODE_SPAN, "$1");
}

export function plainText(input: string): string {
  return input
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, "")
    .trim();
}

// Every link a card carries comes from a field the program owns, so an address in
// model text is broken with a zero-width space to keep the client from linking it.
export function unlinked(input: string): string {
  return input.replace(/https?:\/\/|www\./giu, (prefix) => `${prefix[0]}​${prefix.slice(1)}`);
}
