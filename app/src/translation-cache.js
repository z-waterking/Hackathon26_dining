// Presentation-only cache hydrated from local API responses. Reading
// a page or changing language never creates translation work or network calls.
export { hasChinese, translationParts } from "../shared/translation-text.mjs";

const cache = new Map();
const listeners = new Set();
let revision = 0;

export const subscribeTranslations = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export const translationRevision = () => revision;
export const cachedTranslation = text => cache.get(text);

export function hydrateTranslations(translations = []) {
  let changed = false;
  for (const item of Array.isArray(translations) ? translations : []) {
    if (typeof item?.source !== "string" || !item.source || typeof item.english !== "string" || !item.english.trim()) continue;
    if (cache.get(item.source)?.value === item.english) continue;
    cache.set(item.source, Object.freeze({ status: "ready", value: item.english }));
    changed = true;
  }
  if (!changed) return;
  // Workspace and dedicated Prompt DTOs hydrate separate subsets. Never clear
  // another DTO's translations; changed source text requires its own exact key.
  revision++;
  listeners.forEach(listener => listener());
}
