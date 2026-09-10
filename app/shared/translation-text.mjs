export const hasChinese = text => typeof text === "string" && /\p{Script=Han}/u.test(text);

// This exact splitting is shared by pre-generation and browser lookup. Never
// trim, drop or insert source characters: the cache key is the exact part.
export function translationParts(text) {
  if (typeof text !== "string") return [text];
  const parts = [];
  while (text.length > 2000) {
    const newline = text.lastIndexOf("\n", 2000);
    const end = newline >= 800 ? newline + 1 : 2000;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}
