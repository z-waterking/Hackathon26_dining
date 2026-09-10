import { useEffect, useId, useMemo, useRef, useState } from "react";
import { canvasWordBounds, layoutWordCloud, normalizeWords, WORDCLOUD_FONT, WORDCLOUD_WEIGHT } from "./wordcloud-layout";
import { useI18n } from "./i18n";
import "./feedback-wordcloud.css";

function canvasMeasure() {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  return (text, fontSize) => {
    context.font = `${WORDCLOUD_WEIGHT} ${fontSize}px ${WORDCLOUD_FONT}`;
    return canvasWordBounds(context.measureText(text), fontSize);
  };
}

export default function FeedbackWordCloud({ words = [], label = "反馈热词词云", loading = false, error, onRetry }) {
  const { t, tr, language } = useI18n();
  const container = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const [size, setSize] = useState({ width: 480, height: 236 });
  const [loadedFontText, setLoadedFontText] = useState(null);
  const [measure, setMeasure] = useState();
  // Keywords are source content, not interface labels. A locale switch must
  // never translate, omit, rename or merge the source topics.
  const normalized = useMemo(() => normalizeWords(words), [words]);
  const fontText = normalized.map((word) => word.text).join("");
  const fontsReady = fontText === loadedFontText;

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) setMeasure(() => canvasMeasure()); };
    const fontSet = document.fonts;
    // Loading the actual glyphs handles the bundled font's unicode-range subsets.
    const pending = fontSet ? fontSet.load(`${WORDCLOUD_WEIGHT} 44px ${WORDCLOUD_FONT}`, fontText || "反馈")
      .then(() => fontSet.ready) : Promise.resolve();
    pending.catch(() => {}).then(() => { if (active) { setLoadedFontText(fontText); refresh(); } });
    fontSet?.addEventListener("loadingdone", refresh);
    return () => { active = false; fontSet?.removeEventListener("loadingdone", refresh); };
  }, [fontText]);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);
        if (width > 0 && height > 0) setSize((current) => current.width === width && current.height === height ? current : { width, height });
      });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, []);

  const layout = useMemo(() => {
    if (!fontsReady) return { words: [], omitted: normalized, total: normalized.length };
    return layoutWordCloud(normalized, { ...size, maxFontSize: size.width < 360 ? 38 : 44, measure });
  }, [normalized, size, fontsReady, measure]);
  const errorText = typeof error === "string" ? tr(error) : error?.message ? tr(error.message) : error ? t("反馈热词暂时不可用", "Feedback keywords are temporarily unavailable") : "";
  const waiting = !errorText && (loading || (!fontsReady && normalized.length > 0));

  return <div className="feedback-wordcloud-root" aria-busy={waiting}>
    <div className="feedback-wordcloud-viz" ref={container}>
      {errorText ? <div className="feedback-wordcloud-state" role="alert"><span>{errorText}</span>{onRetry && <button type="button" onClick={onRetry}>{t("重新加载", "Reload")}</button>}</div>
        : waiting ? <div className="feedback-wordcloud-state" role="status"><span className="feedback-wordcloud-loading" aria-hidden="true">•••</span><span>{loading ? t("正在加载反馈热词…", "Loading feedback keywords…") : t("正在排布词云…", "Arranging the word cloud…")}</span></div>
          : !normalized.length ? <div className="feedback-wordcloud-state" role="status"><span className="feedback-wordcloud-empty-mark" aria-hidden="true">{t("词", "Aa")}</span><span>{t("当前反馈暂无可提取的关键词", "No keywords are available for this feedback yet")}</span><small>{t("有新的反馈后，这里会呈现高频主题。", "Recurring topics will appear here as feedback arrives.")}</small></div>
            : !layout.words.length ? <div className="feedback-wordcloud-state" role="status"><span>{t("当前空间不足以完整显示热词", "There is not enough space to display the keywords")}</span><small>{t("请展开页面或使用更宽的窗口查看。", "Expand this panel or use a wider window.")}</small></div>
              : <svg className="feedback-wordcloud-svg" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-labelledby={titleId} aria-describedby={descriptionId}>
                <title id={titleId}>{label === "反馈热词词云" ? t(label, "Feedback word cloud") : t(label)}</title>
                <desc id={descriptionId}>{normalized.map((word) => t(`${word.text}：${word.count} 条反馈`, `${word.text}: ${word.count} feedback records`)).join(language === "en" ? "; " : "；")}{layout.omitted.length ? t(`。当前空间展示 ${layout.words.length} 个词，另有 ${layout.omitted.length} 个词未显示。`, `. Showing ${layout.words.length} words; ${layout.omitted.length} more do not fit.`) : t("。字号越大，提及该词的反馈越多。", ". Larger words are mentioned in more feedback.")}</desc>
                {layout.words.map((word) => <text key={word.text} x={word.centerX} y={word.baselineY} textAnchor="middle" fontFamily={WORDCLOUD_FONT} fontWeight={WORDCLOUD_WEIGHT} fontSize={word.fontSize} fill={word.color} xmlSpace="preserve"><title>{t(`${word.text}：${word.count} 条反馈`, `${word.text}: ${word.count} feedback records`)}</title>{word.text}</text>)}
              </svg>}
    </div>
    {!errorText && !waiting && layout.words.length > 0 && <p className="feedback-wordcloud-caption">{t("字号代表提及反馈数", "Word size reflects feedback count")}{layout.omitted.length > 0 ? t(` · 展示 ${layout.words.length} / ${layout.total} 个热词`, ` · Showing ${layout.words.length} / ${layout.total} keywords`) : t(" · 悬停查看数量", " · Hover for counts")}</p>}
  </div>;
}
