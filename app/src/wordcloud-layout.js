export const WORDCLOUD_FONT = '"Noto Sans SC Variable", "Noto Sans SC", "Microsoft YaHei UI", sans-serif';
export const WORDCLOUD_WEIGHT = 600;
const COLORS = ["#147c70", "#205f8e", "#6262a5", "#217f80", "#0d665e", "#755c98", "#4275a6"];
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Counts for duplicate, identical tokens are combined; invalid entries are ignored. */
export function normalizeWords(input) {
  const counts = new Map();
  for (const item of Array.isArray(input) ? input : []) {
    if (typeof item?.text !== "string" || !item.text.trim() || [...item.text].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
      || typeof item.count !== "number" || !Number.isFinite(item.count) || item.count <= 0) continue;
    const count = (counts.get(item.text) || 0) + item.count;
    if (Number.isFinite(count)) counts.set(item.text, count);
  }
  return [...counts].map(([text, count]) => ({ text, count }))
    .sort((left, right) => right.count - left.count || (left.text < right.text ? -1 : left.text > right.text ? 1 : 0));
}

function hashText(text) {
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return hash >>> 0;
}

/** A conservative fallback used outside a browser; the component uses canvas glyph metrics. */
export function estimateWordSize(text, fontSize) {
  const width = [...text].reduce((sum, character) => sum + (character.codePointAt(0) > 255 ? 1 : 0.68), 0) * fontSize;
  return { width, ascent: fontSize * 0.9, descent: fontSize * 0.24 };
}

/** Canvas ink bounds alone exclude SVG's taller font character cell. Reserve both. */
export function canvasWordBounds(metrics, fontSize) {
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? metrics.actualBoundingBoxLeft : 0;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width;
  const width = Math.max(metrics.width, 2 * Math.max(Math.abs(metrics.width / 2 + left), Math.abs(right - metrics.width / 2)));
  const ascent = Math.max(Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : 0,
    Number.isFinite(metrics.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : fontSize * 1.2);
  const descent = Math.max(Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : 0,
    Number.isFinite(metrics.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : fontSize * 0.32);
  return { width, ascent, descent };
}

export function boxesOverlap(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function measuredWord(word, fontSize, measure, padding) {
  const raw = measure(word.text, fontSize);
  const metrics = typeof raw === "number" ? { width: raw } : raw || {};
  const width = metrics.width;
  const ascent = Number.isFinite(metrics.ascent) && metrics.ascent >= 0 ? metrics.ascent : fontSize * 0.9;
  const descent = Number.isFinite(metrics.descent) && metrics.descent >= 0 ? metrics.descent : fontSize * 0.24;
  if (!Number.isFinite(width) || width <= 0) return null;
  const glyphHeight = ascent + descent;
  const height = Math.max(fontSize * 1.1, glyphHeight);
  return { ...word, fontSize, width: width + padding * 2, height: height + padding * 2,
    baselineOffset: padding + (height - glyphHeight) / 2 + ascent, color: COLORS[hashText(word.text) % COLORS.length] };
}

/**
 * Deterministic, horizontal SVG word cloud. Rectangles include a breathing gap, and
 * every placement is checked for collision and bounds. A golden-angle spiral packs
 * high-count words first. All words share each font-scale adjustment, preserving
 * count ordering; tokens that cannot fit are returned in `omitted`, never truncated.
 * `measure(text, fontSize)` accepts either a width or {width, ascent, descent}.
 */
export function layoutWordCloud(input, { width = 480, height = 236, minFontSize = 13, maxFontSize = 44, padding = 3, measure = estimateWordSize } = {}) {
  const normalized = normalizeWords(input);
  const result = { width, height, words: [], omitted: normalized, total: normalized.length };
  if (!normalized.length || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return result;
  const minimum = Number.isFinite(minFontSize) && minFontSize > 0 ? minFontSize : 13;
  const maximum = Number.isFinite(maxFontSize) && maxFontSize >= minimum ? maxFontSize : Math.max(44, minimum);
  const gap = Number.isFinite(padding) && padding >= 0 ? padding : 3;
  const largestCount = normalized[0].count;
  const radius = Math.hypot(width, height) / 2;
  const aspect = Math.min(2.2, Math.max(0.7, width / height));
  const attempts = Math.min(6500, Math.max(1800, Math.ceil(width * height / 25)));
  const positions = Array.from({ length: attempts }, (_, index) => {
    const distance = radius * Math.sqrt(index / attempts);
    return { x: Math.cos(index * GOLDEN_ANGLE) * distance * Math.sqrt(aspect), y: Math.sin(index * GOLDEN_ANGLE) * distance / Math.sqrt(aspect) };
  });
  const measurements = new Map();
  let best = result;
  for (const scale of [1, 0.88, 0.76, 0.64, 0.52, 0.4, 0.28]) {
    const placed = [];
    const omitted = [];
    for (const word of normalized) {
      const fontSize = Math.round((minimum + (maximum - minimum) * Math.sqrt(word.count / largestCount) * scale) * 10) / 10;
      const cacheKey = `${fontSize}:${word.text}`;
      if (!measurements.has(cacheKey)) measurements.set(cacheKey, measuredWord(word, fontSize, measure, gap));
      const item = measurements.get(cacheKey);
      if (!item || item.width > width || item.height > height) { omitted.push(word); continue; }
      const phase = (hashText(word.text) % 12) / 12 * Math.PI * 2;
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      let location;
      for (const point of positions) {
        const x = width / 2 + point.x * cos - point.y * sin - item.width / 2;
        const y = height / 2 + point.x * sin + point.y * cos - item.height / 2;
        const box = { x, y, width: item.width, height: item.height };
        if (x < 0 || y < 0 || x + item.width > width || y + item.height > height || placed.some((existing) => boxesOverlap(existing, box))) continue;
        location = { ...item, x, y, centerX: x + item.width / 2, baselineY: y + item.baselineOffset };
        break;
      }
      if (location) placed.push(location);
      else omitted.push(word);
    }
    if (placed.length > best.words.length) best = { width, height, words: placed, omitted, total: normalized.length };
    if (!omitted.length) break;
  }
  return best;
}
