import { cachedTranslationView, prewarmUiTranslations } from "./ui-translations.mjs";
import { collectTranslationSources, collectPayloadTranslationSources } from "./translation-sources.mjs";

// English is a separate presentation artifact. Reads only load prepared rows;
// writes prepare changed text before delivery without rewriting business data.
export function createPreparedEnglish(store, ai, { root, enabled = false } = {}) {
  return async (payload, { prepare = false, includePrompts = false, includeWorkspace = false } = {}) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.pipe === "function") return payload;
    const texts = includeWorkspace
      ? collectTranslationSources(store, { root, includePrompts: false, payloads: [payload] })
      : collectPayloadTranslationSources(payload, { includePrompts });
    const before = cachedTranslationView(store, texts);
    let failed = false;
    if (enabled && prepare && before.missing) {
      try { await prewarmUiTranslations(store, ai, texts); }
      catch {
        // The business operation has already succeeded. Never make the client
        // retry that write because a separate display translation failed.
        failed = true;
      }
    }
    const view = cachedTranslationView(store, texts);
    if (!view.translations.length && !payload.uiTranslations && !failed) return payload;
    return { ...payload, uiTranslations: [...new Map([...(payload.uiTranslations || []), ...view.translations].map(item => [item.source, item])).values()],
      ...(failed ? { englishPreparation: { status: "unavailable", missing: view.missing } } : {}),
    };
  };
}
