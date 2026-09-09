import test from "node:test";
import assert from "node:assert/strict";
import { boxesOverlap, canvasWordBounds, layoutWordCloud, normalizeWords } from "../src/wordcloud-layout.js";

const feedbackWords = ["菜品种类", "口味", "素食", "排队", "食材新鲜", "服务态度", "分量", "温度", "早餐", "咖啡", "价格", "少油", "少盐", "环境", "餐具", "清洁", "打包", "过敏原", "Halal", "vegan options", "服务效率", "汤面", "饮品", "水果"]
  .map((text, index) => ({ text, count: 32 - index }));

function checkLayout(layout) {
  for (const word of layout.words) {
    assert.ok(Number.isFinite(word.x) && Number.isFinite(word.y));
    assert.ok(word.x >= 0 && word.y >= 0, `${word.text} starts inside bounds`);
    assert.ok(word.x + word.width <= layout.width && word.y + word.height <= layout.height, `${word.text} ends inside bounds`);
    assert.ok(word.baselineY >= word.y && word.baselineY <= word.y + word.height);
  }
  for (let left = 0; left < layout.words.length; left++) {
    for (let right = left + 1; right < layout.words.length; right++) {
      assert.equal(boxesOverlap(layout.words[left], layout.words[right]), false, `${layout.words[left].text} and ${layout.words[right].text} must not overlap`);
    }
  }
  assert.equal(layout.words.length + layout.omitted.length, layout.total);
}

test("word cloud is deterministic, keeps original tokens and weights, and contains no overlapping words", () => {
  const first = layoutWordCloud(feedbackWords, { width: 500, height: 236 });
  assert.deepEqual(first, layoutWordCloud([...feedbackWords].reverse(), { width: 500, height: 236 }));
  assert.ok(first.words.length >= 18, "packs a useful number of weighted words");
  checkLayout(first);
  for (let index = 1; index < first.words.length; index++) assert.ok(first.words[index - 1].fontSize >= first.words[index].fontSize);
  for (const word of [...first.words, ...first.omitted]) assert.equal(word.count, feedbackWords.find((item) => item.text === word.text).count);
  assert.ok(new Set(first.words.map((word) => Math.round(word.y))).size > 5, "places an organic cloud, not a single row of words");
});

test("mobile and unusually narrow sizes remain in bounds and declare omitted whole words", () => {
  for (const width of [300, 240, 120, 45]) {
    const layout = layoutWordCloud(feedbackWords, { width, height: 236 });
    checkLayout(layout);
    assert.deepEqual([...layout.words, ...layout.omitted].map((word) => word.text).sort(), feedbackWords.map((word) => word.text).sort());
    if (width === 300) assert.ok(layout.words.length >= 12);
  }
  const word = { text: "一个必须完整保留且不会截断的极长中文关键词", count: 8 };
  const tiny = layoutWordCloud([word], { width: 80, height: 40 });
  assert.deepEqual(tiny.omitted, [word]);
});

test("duplicates combine exactly; invalid tokens and counts never produce fake or broken words", () => {
  const input = [{ text: "早餐", count: 4 }, { text: "早餐", count: 2 }, { text: " breakfast ", count: 3 },
    { text: "", count: 99 }, { text: "  ", count: 99 }, { text: "换\n行", count: 2 },
    { text: "零", count: 0 }, { text: "负", count: -1 }, { text: "NaN", count: NaN }, { text: "无限", count: Infinity },
    { text: "字符串", count: "3" }, null, false];
  assert.deepEqual(normalizeWords(input), [{ text: "早餐", count: 6 }, { text: " breakfast ", count: 3 }]);
  assert.deepEqual(normalizeWords(undefined), []);
  assert.equal(layoutWordCloud(input).total, 2);
  assert.deepEqual(layoutWordCloud([]).words, []);
});

test("custom measurement includes actual English/Chinese width and baseline metrics", () => {
  const calls = [];
  const measure = (text, fontSize) => {
    calls.push({ text, fontSize });
    return { width: text === "WWW" ? 3.1 * fontSize : fontSize, ascent: fontSize * 0.8, descent: fontSize * 0.25 };
  };
  const layout = layoutWordCloud([{ text: "WWW", count: 5 }, { text: "iii", count: 5 }], { measure, padding: 4 });
  const wide = layout.words.find((word) => word.text === "WWW");
  const narrow = layout.words.find((word) => word.text === "iii");
  assert.ok(calls.length > 0);
  assert.equal(wide.width, wide.fontSize * 3.1 + 8);
  assert.equal(narrow.width, narrow.fontSize + 8);
  assert.equal(wide.fontSize, narrow.fontSize, "equal counts use equal sizes, independent of text length");
  checkLayout(layout);
});

test("invalid viewport and invalid measurements fail safely without out-of-bounds placement", () => {
  for (const size of [{ width: 0 }, { width: -1 }, { width: Infinity }, { height: NaN }, { height: 0 }]) {
    const result = layoutWordCloud(feedbackWords, size);
    assert.deepEqual(result.words, []);
    assert.equal(result.omitted.length, feedbackWords.length);
  }
  for (const measure of [() => NaN, () => ({ width: -1 }), () => ({ width: Infinity })]) {
    assert.equal(layoutWordCloud(feedbackWords, { measure }).words.length, 0);
  }
});

test("forty equally weighted topics pack safely, retain equal size, and use accessible colors", () => {
  const input = Array.from({ length: 40 }, (_, index) => ({ text: `主题${index}`, count: 3 }));
  const layout = layoutWordCloud(input, { width: 480, height: 236 });
  checkLayout(layout);
  assert.ok(layout.words.length >= 30);
  assert.equal(new Set(layout.words.map((word) => word.fontSize)).size, 1);
  for (const color of new Set(layout.words.map((word) => word.color))) {
    const components = color.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
    assert.ok(1.05 / (luminance + 0.05) >= 4.5, `${color} meets normal-text contrast against white`);
  }
});

test("SVG character cells reserve font bounds as well as glyph ink bounds", () => {
  // Edge / Noto Sans SC Variable at 44px: glyph ink is 42px tall, SVG cell is 64px.
  const metrics = { width: 88, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 88,
    actualBoundingBoxAscent: 38, actualBoundingBoxDescent: 4, fontBoundingBoxAscent: 51, fontBoundingBoxDescent: 13 };
  assert.deepEqual(canvasWordBounds(metrics, 44), { width: 88, ascent: 51, descent: 13 });
  const layout = layoutWordCloud([{ text: "清淡", count: 8 }, { text: "素菜", count: 8 }],
    { width: 518, height: 231, measure: () => canvasWordBounds(metrics, 44) });
  checkLayout(layout);
  assert.equal(layout.words.length, 2);
  assert.equal(layout.words[0].height, 70, "64px font cell plus 6px gap");
  const cells = layout.words.map((word) => ({ x: word.centerX - 44, y: word.baselineY - 51, width: 88, height: 64 }));
  assert.equal(boxesOverlap(cells[0], cells[1]), false, "real SVG text cells cannot overlap");
  assert.ok(canvasWordBounds({ width: 20, actualBoundingBoxAscent: 18, actualBoundingBoxDescent: 2 }, 20).ascent >= 24,
    "older engines without font metrics use a conservative font-cell fallback");
});
