import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { languageLocale, normalizeLanguage, persistLanguage, readLanguage, sourceText, translate } from "./i18n-text";

const I18nContext = createContext({ language: "zh", locale: "zh-CN", t: (text) => text, setLanguage: () => {} });
// Compatibility wrapper: visibility no longer schedules translation work.
export function I18nVisibility({ children }) { return children; }
function browserStorage() { try { return window.localStorage; } catch { return null; } }
export function I18nProvider({ children }) {
  const [language, setCurrentLanguage] = useState(() => readLanguage(browserStorage()));
  useEffect(() => {
    document.documentElement.lang = languageLocale(language);
    document.title = language === "en" ? "Dining · BJW Operations" : "餐叙 · BJW 餐饮运营工作台";
  }, [language]);
  const value = useMemo(() => ({
    language, locale: languageLocale(language),
    t: (chinese, english) => translate(language, chinese, english),
    setLanguage: next => {
      const normalized = normalizeLanguage(next);
      persistLanguage(browserStorage(), normalized);
      setCurrentLanguage(normalized);
    },
  }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
// This module intentionally shares a context hook and its providers.
// oxlint-disable-next-line react/only-export-components
export function useI18n() {
  const base = useContext(I18nContext);
  // t() is for application-authored labels. tr() is retained at existing
  // record-rendering call sites as an explicit, locale-independent boundary.
  return useMemo(() => ({ ...base, tr: sourceText }), [base]);
}
