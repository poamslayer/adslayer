/** About 10,000 tokens at four characters per token. */
export const DEFAULT_MAX_CHARS = 40_000;

export function capJson(value: unknown, maxChars: number = DEFAULT_MAX_CHARS): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    text = JSON.stringify({ error: "Circular or unserialisable value" });
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "\n...[truncated]", truncated: true };
}

/**
 * Picks the first whole payload that fits inside the cap. A tool result costs the model tokens
 * for every part of it, not only the part the script returned, so a shaper measures the whole
 * thing and offers a ladder of candidates from richest to barest. The last rung is returned even
 * when it does not fit, because the result still has to come back in the declared shape.
 */
export function shedToFit<T>(candidates: [T, ...T[]], maxChars: number = DEFAULT_MAX_CHARS): T {
  const barest = candidates.length - 1;
  for (let rung = 0; rung < barest; rung += 1) {
    if (capJson(candidates[rung], maxChars).text.length <= maxChars) return candidates[rung];
  }
  return candidates[barest];
}
