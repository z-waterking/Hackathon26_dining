import { useEffect, useId, useMemo, useRef, useState } from "react";
import { canvasWordBounds, layoutWordCloud, normalizeWords, WORDCLOUD_FONT, WORDCLOUD_WEIGHT } from "./wordcloud-layout";
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
  const container = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const [size, setSize] = useState({ width: 480, height: 236 });
  const [loadedFontText, setLoadedFontText] = useState(null);
  const [measure, setMeasure] = useState();
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
  const waiting = loading || (!fontsReady && normalized.length > 0);
  const errorText = typeof error === "string" ? error : error?.message || (error ? "反馈热词暂时不可用" : "");

  return <div className="feedback-wordcloud-root" aria-busy={waiting}>
    <div className="feedback-wordcloud-viz" ref={container}>
      {errorText ? <div className="feedback-wordcloud-state" role="alert"><span>{errorText}</span>{onRetry && <button type="button" onClick={onRetry}>重新加载</button>}</div>
        : waiting ? <div className="feedback-wordcloud-state" role="status"><span className="feedback-wordcloud-loading" aria-hidden="true">•••</span><span>{loading ? "正在加载反馈热词…" : "正在排布词云…"}</span></div>
          : !normalized.length ? <div className="feedback-wordcloud-state" role="status"><span className="feedback-wordcloud-empty-mark" aria-hidden="true">词</span><span>当前反馈暂无可提取的关键词</span><small>有新的反馈后，这里会呈现高频主题。</small></div>
            : !layout.words.length ? <div className="feedback-wordcloud-state" role="status"><span>当前空间不足以完整显示热词</span><small>请展开页面或使用更宽的窗口查看。</small></div>
              : <svg className="feedback-wordcloud-svg" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-labelledby={titleId} aria-describedby={descriptionId}>
                <title id={titleId}>{label}</title>
                <desc id={descriptionId}>{normalized.map((word) => `${word.text}：${word.count} 条反馈`).join("；")}{layout.omitted.length ? `。当前空间展示 ${layout.words.length} 个词，另有 ${layout.omitted.length} 个词未显示。` : "。字号越大，提及该词的反馈越多。"}</desc>
                {layout.words.map((word) => <text key={word.text} x={word.centerX} y={word.baselineY} textAnchor="middle" fontFamily={WORDCLOUD_FONT} fontWeight={WORDCLOUD_WEIGHT} fontSize={word.fontSize} fill={word.color} xmlSpace="preserve"><title>{word.text}：{word.count} 条反馈</title>{word.text}</text>)}
              </svg>}
    </div>
    {!errorText && !waiting && layout.words.length > 0 && <p className="feedback-wordcloud-caption">字号代表提及反馈数{layout.omitted.length > 0 ? ` · 展示 ${layout.words.length} / ${layout.total} 个热词` : " · 悬停查看数量"}</p>}
  </div>;
}
