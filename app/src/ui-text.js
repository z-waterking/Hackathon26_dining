export function readable(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join("；");
  return value.text || value.summary || value.description || value.reason || JSON.stringify(value);
}
