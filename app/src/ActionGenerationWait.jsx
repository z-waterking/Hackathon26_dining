import { useId } from "react";
import { Sparkles } from "lucide-react";

export default function ActionGenerationWait({ count, month }) {
  const titleId = useId();
  const descriptionId = useId();
  return <section className="action-generation-wait" aria-labelledby={titleId} aria-describedby={descriptionId}>
    <div className="action-wait-art" aria-hidden="true">
      <span className="action-wait-ring" /><span className="action-wait-ring inner" />
      <div className="action-wait-core"><Sparkles size={30} strokeWidth={1.5} /></div>
    </div>
    <span className="action-wait-eyebrow">AI IS WORKING</span>
    <h2 id={titleId}>正在生成改善事项</h2>
    <p id={descriptionId}>AI 正在分析{month || "全部月份"}的 <strong>{count}</strong> 条真实反馈，<br />整理可执行的改进措施与原文依据。</p>
    <div className="action-wait-track" aria-hidden="true"><span /></div>
    <p className="action-wait-status" role="status">请稍候，完成后将自动显示结果<span className="action-wait-dots" aria-hidden="true"><i /><i /><i /></span></p>
    <small>可切换到其他页面继续操作，返回此页查看结果；请勿刷新浏览器</small>
  </section>;
}
