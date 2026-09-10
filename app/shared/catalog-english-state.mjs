// Read-only projection for persisted dish-English metadata. Invalid existing
// values are flagged for review, never silently changed or translated.
export function isValidEnglishName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200 &&
    /[A-Za-z]/.test(value) && !/\p{Script=Han}/u.test(value) &&
    ![...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

export function englishNameState(dish) {
  if (typeof dish?.english !== "string" || !dish.english.trim()) return "missing";
  const sourceName = typeof dish.name === "string" ? dish.name.trim() : "";
  if (!isValidEnglishName(dish.english) || dish.englishName?.origin === "ai" || dish.englishName?.status === "needs_review" ||
    dish.englishName?.sourceName && dish.englishName.sourceName !== sourceName) return "needs_review";
  return "ready";
}
