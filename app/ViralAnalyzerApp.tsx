"use client";
/* eslint-disable @next/next/no-img-element -- local archived media is served dynamically and already sized by CSS */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  AlertCircle, ArrowRight, BarChart3, Bookmark, Bot, BrainCircuit, Check, CheckCircle2, ChevronRight, CircleGauge,
  Clock3, Eye, FileVideo2, Flame, FolderArchive, GitCompareArrows, ImageIcon, Languages, LayoutDashboard,
  Lightbulb, Link2, LoaderCircle, MessageCircle, Package, Pencil, Play, Plus, RefreshCw, Search, Settings,
  ExternalLink, Radio, Send, Share2, Sparkles, Square, Star, Target, Trash2, Upload, Users, Volume2, WandSparkles, X, Zap,
} from "lucide-react";
import type { DashboardPayload, FeishuSettings, FeishuTarget, LearningOverview, LearningProfile, Product, ProviderSetting, SceneRecord, VideoRecord } from "@/lib/types";

type ViewName = "dashboard" | "products" | "analyze" | "compare" | "learning" | "settings";
type ProductDraft = Pick<Product, "name" | "pid" | "category" | "market" | "price" | "sellingPoints" | "targetAudience" | "painPoints" | "competitors" | "productUrl" | "bannedTerms" | "notes">;

const emptyProduct: ProductDraft = {
  name: "", pid: "", category: "", market: "美国", price: "", sellingPoints: "", targetAudience: "",
  painPoints: "", competitors: "", productUrl: "", bannedTerms: "", notes: "",
};

const navItems = [
  { id: "dashboard" as const, label: "分析总览", icon: LayoutDashboard },
  { id: "products" as const, label: "产品库", icon: Package },
  { id: "analyze" as const, label: "批量分析", icon: Sparkles },
  { id: "compare" as const, label: "视频对比", icon: GitCompareArrows },
  { id: "learning" as const, label: "学习中心", icon: BrainCircuit },
];

const statusText: Record<string, string> = {
  waiting: "等待分析", queued: "排队中", downloading: "获取视频", transcribing: "识别文案",
  extracting: "拆分镜头", analyzing: "AI 分析", completed: "已完成", stopped: "已停止", failed: "失败",
};

function api<T>(url: string, options?: RequestInit): Promise<T> {
  return fetch(url, options).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload as T;
  });
}

function mediaUrl(value: string | null | undefined) {
  return value ? `/api/media/${value.split("/").map(encodeURIComponent).join("/")}` : "";
}

function compactNumber(value: number | null) {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

function formatDate(value: string | null) {
  if (!value) return "待获取";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return "--:--";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function scoreTone(score: number) {
  return score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "average" : "weak";
}

function ScoreRing({ value, label, size = "normal" }: { value: number; label: string; size?: "small" | "normal" | "large" }) {
  return (
    <div className={`score-ring ${scoreTone(value)} ${size}`} style={{ "--score": `${value * 3.6}deg` } as CSSProperties}>
      <div className="score-ring-inner"><strong>{value || "—"}</strong><span>{label}</span></div>
    </div>
  );
}

function VideoThumb({ video, compact = false }: { video: VideoRecord; compact?: boolean }) {
  const cover = mediaUrl(video.coverPath);
  return (
    <div className={`video-thumb ${compact ? "compact" : ""}`}>
      {cover ? <img src={cover} alt={video.title || "视频封面"} /> : <div className="thumb-placeholder"><FileVideo2 size={compact ? 26 : 34} /><span>等待封面</span></div>}
      <span className="duration-badge">{formatDuration(video.durationSeconds)}</span>
      {video.status !== "completed" && <span className={`status-badge ${video.status}`}><LoaderCircle size={12} />{statusText[video.status]}</span>}
    </div>
  );
}

function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Package; title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function Radar({ video, color = "#ff5b36" }: { video: VideoRecord; color?: string }) {
  const values = [video.scores.traffic, video.scores.conversion, video.scores.visual, video.scores.product, video.scores.audio, video.scores.rhythm];
  const points = values.map((value, index) => {
    const angle = (-90 + index * 60) * Math.PI / 180;
    const radius = 46 * value / 100;
    return `${50 + Math.cos(angle) * radius}% ${50 + Math.sin(angle) * radius}%`;
  }).join(",");
  return (
    <div className="radar-wrap">
      <div className="radar-grid"><div /><div /><div /></div>
      <div className="radar-shape" style={{ clipPath: `polygon(${points})`, background: color }} />
      {[["流量", 0], ["转化", 1], ["画面", 2], ["产品", 3], ["声音", 4], ["节奏", 5]].map(([label, index]) => (
        <span key={String(label)} className={`radar-label l${index}`}>{label}</span>
      ))}
    </div>
  );
}

function AppShell({ children, view, setView, data, search, setSearch }: {
  children: React.ReactNode; view: ViewName; setView: (view: ViewName) => void; data: DashboardPayload | null;
  search: string; setSearch: (value: string) => void;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("dashboard")}><span className="brand-mark"><Flame /></span><span><strong>爆片分析</strong><small>VIRAL LAB</small></span></button>
        <nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon /><span>{label}</span>{id === "analyze" && data?.totals.processing ? <b>{data.totals.processing}</b> : null}</button>)}</nav>
        <div className="sidebar-products"><div className="side-section-title"><span>产品档案</span><button aria-label="打开产品库" onClick={() => setView("products")}><Plus /></button></div>{data?.products.slice(0, 5).map((product) => <button key={product.id} className="side-product" onClick={() => setView("products")}><span className="product-dot">{product.name.slice(0, 1)}</span><span>{product.name}</span><small>{product.videoCount}</small></button>)}</div>
        <div className="sidebar-bottom"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings /><span>接口设置</span></button><div className="local-chip"><span /><div><strong>本机模式</strong><small>数据只存在这台电脑</small></div></div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="global-search"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索产品、账号、文案…" /></div><div className="top-actions"><div className="provider-state">{data?.providers.map((provider) => <span key={provider.provider} className={provider.hasKey && provider.enabled ? "online" : ""}>{provider.provider === "openai" ? "OpenAI" : provider.provider === "qwen" ? "Qwen" : "TokScript"}</span>)}</div><button className="primary-action" onClick={() => setView("analyze")}><Plus />分析视频</button></div></header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function DashboardView({ data, onOpen, setView }: { data: DashboardPayload; onOpen: (video: VideoRecord) => void; setView: (view: ViewName) => void }) {
  const recent = data.videos.slice(0, 8);
  const top = data.videos.filter((video) => video.status === "completed").sort((a, b) => b.scores.traffic + b.scores.conversion - a.scores.traffic - a.scores.conversion)[0];
  return (
    <>
      <section className="page-heading"><div><span className="eyebrow">TODAY’S VIRAL WORKSPACE</span><h1>把爆款拆成可以复拍的答案</h1><p>从原文案、镜头和声音，一直看到钩子、爆点与带货转化逻辑。</p></div><button className="button secondary" onClick={() => setView("products")}><FolderArchive />管理产品档案</button></section>
      <section className="hero-grid">
        <button className="start-card" onClick={() => setView("analyze")}><div className="start-glow" /><div className="start-icon"><WandSparkles /></div><span className="eyebrow">NEW ANALYSIS</span><h2>粘贴 TikTok 链接<br />开始拆解爆片</h2><p>一次最多 10 条，也可以上传本地视频。系统会自动分镜、翻译并生成关键片段。</p><span className="start-cta">开始分析 <ArrowRight /></span><div className="start-tags"><span>英语 / 西语识别</span><span>中文深度报告</span></div></button>
        <div className="metrics-panel"><div className="metric-card"><span className="metric-icon coral"><FileVideo2 /></span><div><small>视频存档</small><strong>{data.totals.videos}</strong><em>长期保存在本机</em></div></div><div className="metric-card"><span className="metric-icon purple"><Package /></span><div><small>产品档案</small><strong>{data.totals.products}</strong><em>{data.products.filter((p) => !p.isSystem).map((p) => p.name).slice(0, 2).join(" · ") || "等待创建"}</em></div></div><div className="metric-card"><span className="metric-icon green"><Zap /></span><div><small>平均流量分</small><strong>{data.totals.averageTraffic || "—"}</strong><em>独立于转化评分</em></div></div><div className="metric-card"><span className="metric-icon blue"><Target /></span><div><small>平均转化分</small><strong>{data.totals.averageConversion || "—"}</strong><em>{data.totals.completed} 条完成分析</em></div></div></div>
        <div className="best-card">{top ? <><div className="card-title"><span><Flame />当前最高潜力</span><button onClick={() => onOpen(top)}>查看报告 <ChevronRight /></button></div><div className="best-content"><VideoThumb video={top} compact /><div><span className="product-pill">{top.productName}</span><h3>{top.title || "未命名视频"}</h3><p>{top.hookSummary || top.summary}</p><div className="score-row"><ScoreRing value={top.scores.traffic} label="流量" size="small" /><ScoreRing value={top.scores.conversion} label="转化" size="small" /></div></div></div></> : <EmptyState icon={BarChart3} title="等待第一份报告" text="配置接口并分析样片后，这里会显示最值得复拍的视频。" />}</div>
      </section>
      <section className="section-block"><div className="section-heading"><div><h2>最近视频</h2><p>按最新入库顺序显示，处理中任务会自动刷新进度。</p></div><button className="text-button" onClick={() => setView("analyze")}>查看全部任务 <ChevronRight /></button></div>{recent.length ? <div className="video-grid">{recent.map((video) => <button className="video-card" key={video.id} onClick={() => onOpen(video)}><VideoThumb video={video} /><div className="video-card-body"><div className="card-meta"><span>{video.productName}</span><span>{formatDate(video.publishedAt || video.createdAt)}</span></div><h3>{video.title || video.sourceFileName || "待获取视频信息"}</h3><p className="account">@{video.accountName || "待获取账号"}</p>{video.status === "completed" ? <div className="card-scores"><div><small>流量</small><strong>{video.scores.traffic}</strong></div><span /><div><small>转化</small><strong>{video.scores.conversion}</strong></div></div> : <div className="progress-wrap"><div><span>{video.stage}</span><strong>{video.progress}%</strong></div><div className="progress-track"><i style={{ width: `${video.progress}%` }} /></div>{video.errorMessage && <p className="error-line">{video.errorMessage}</p>}</div>}</div></button>)}</div> : <EmptyState icon={FileVideo2} title="还没有视频" text="先创建产品档案，然后粘贴链接或上传视频。" action={<button className="button primary" onClick={() => setView("analyze")}>开始分析</button>} />}</section>
    </>
  );
}

function ProductsView({ data, refresh, toast }: { data: DashboardPayload; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [editing, setEditing] = useState<Product | null | "new">(null);
  const [draft, setDraft] = useState<ProductDraft>(emptyProduct);
  const [image, setImage] = useState<File | null>(null);
  const openEditor = (product?: Product) => { setEditing(product || "new"); setDraft(product ? { name: product.name, pid: product.pid, category: product.category, market: product.market, price: product.price, sellingPoints: product.sellingPoints, targetAudience: product.targetAudience, painPoints: product.painPoints, competitors: product.competitors, productUrl: product.productUrl, bannedTerms: product.bannedTerms, notes: product.notes } : emptyProduct); setImage(null); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = editing === "new"
        ? await api<{ product: Product }>("/api/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) })
        : await api<{ product: Product }>(`/api/products/${editing!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      if (image) { const form = new FormData(); form.append("file", image); await api(`/api/products/${result.product.id}/image`, { method: "POST", body: form }); }
      await refresh(); setEditing(null); toast("产品档案已保存");
    } catch (error) { toast(error instanceof Error ? error.message : "保存失败", true); }
  };
  return <><section className="page-heading"><div><span className="eyebrow">PRODUCT LIBRARY</span><h1>产品爆片档案库</h1><p>每个产品单独积累视频、AI报告和团队人工判断，越用越贴合你们的标准。</p></div><button className="button primary" onClick={() => openEditor()}><Plus />新建产品</button></section><div className="product-grid">{data.products.map((product) => <article className={`product-card ${product.isSystem ? "system" : ""}`} key={product.id}><div className="product-cover">{product.imagePath ? <img src={mediaUrl(product.imagePath)} alt={product.name} /> : <span>{product.name.slice(0, 1)}</span>}<button onClick={() => openEditor(product)} aria-label="编辑产品"><Pencil /></button></div><div className="product-card-body"><div className="product-heading"><div><span>{product.category || "未设置品类"} · {product.market || "未设置市场"}</span><h3>{product.name}</h3></div><strong>{product.videoCount}<small>条视频</small></strong></div><p>{product.sellingPoints || product.notes || "补充卖点、目标用户和痛点后，AI分析会更准确。"}</p><div className="product-facts"><span><Target />{product.targetAudience || "目标用户待补充"}</span><span><Lightbulb />{product.painPoints || "核心痛点待补充"}</span></div><button className="card-link" onClick={() => openEditor(product)}>查看并编辑档案 <ChevronRight /></button></div></article>)}</div>{editing && <div className="modal-backdrop"><form className="modal product-modal" onSubmit={save}><div className="modal-title"><div><span className="eyebrow">PRODUCT PROFILE</span><h2>{editing === "new" ? "新建产品档案" : "编辑产品档案"}</h2></div><button type="button" onClick={() => setEditing(null)}><X /></button></div><div className="form-grid"><label className="span-2">产品名称<input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：便携榨汁杯" /></label><label>品类<input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="家居 / 美妆 / 3C" /></label><label>目标国家<input value={draft.market} onChange={(e) => setDraft({ ...draft, market: e.target.value })} placeholder="美国" /></label><label>售价<input value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="$29.99" /></label><label>产品图片<input type="file" accept="image/*" onChange={(e) => setImage(e.target.files?.[0] || null)} /></label><label className="span-2">主要卖点<textarea value={draft.sellingPoints} onChange={(e) => setDraft({ ...draft, sellingPoints: e.target.value })} placeholder="一行一个卖点" /></label><label>目标用户<textarea value={draft.targetAudience} onChange={(e) => setDraft({ ...draft, targetAudience: e.target.value })} /></label><label>核心痛点<textarea value={draft.painPoints} onChange={(e) => setDraft({ ...draft, painPoints: e.target.value })} /></label><label>竞品<textarea value={draft.competitors} onChange={(e) => setDraft({ ...draft, competitors: e.target.value })} /></label><label>禁用词/合规要求<textarea value={draft.bannedTerms} onChange={(e) => setDraft({ ...draft, bannedTerms: e.target.value })} /></label><label className="span-2">产品链接<input value={draft.productUrl} onChange={(e) => setDraft({ ...draft, productUrl: e.target.value })} /></label><label className="span-2">团队备注<textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button><button className="button primary"><Check />保存档案</button></div></form></div>}</>;
}

function QuickProductModal({ onClose, onCreated, toast }: { onClose: () => void; onCreated: (product: Product) => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [draft, setDraft] = useState({ name: "", category: "", pid: "" });
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setSaving(true);
      const result = await api<{ product: Product }>("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      await onCreated(result.product);
      toast("产品档案已创建并自动选中");
    } catch (error) {
      toast(error instanceof Error ? error.message : "创建产品失败", true);
    } finally {
      setSaving(false);
    }
  };
  return <div className="modal-backdrop"><form className="modal quick-product-modal" onSubmit={save}><div className="modal-title"><div><span className="eyebrow">QUICK CREATE</span><h2>新增产品档案</h2><p>先填写分析所需的基础信息，其他资料可以稍后在产品库补充。</p></div><button type="button" onClick={onClose}><X /></button></div><div className="form-grid quick-product-form"><label className="span-2">产品名称<input required autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：多功能便携充电宝" /></label><label>产品类目<input required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="例如：3C数码" /></label><label>PID（选填）<input value={draft.pid} onChange={(event) => setDraft({ ...draft, pid: event.target.value })} placeholder="平台产品 ID" /></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Plus />}创建并选中</button></div></form></div>;
}

function AnalyzeView({ data, refresh, toast, onOpen }: { data: DashboardPayload; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void; onOpen: (video: VideoRecord) => void }) {
  const [mode, setMode] = useState<"links" | "files">("links");
  const [productId, setProductId] = useState(data.products[0]?.id || "");
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [quickProductOpen, setQuickProductOpen] = useState(false);
  const parsedLinks = links.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  const submit = async () => {
    try {
      setSubmitting(true);
      if (mode === "links") {
        await api("/api/videos/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId, urls: parsedLinks }) });
        setLinks("");
      } else {
        const form = new FormData(); form.append("productId", productId); files.forEach((file) => form.append("files", file));
        await api("/api/videos/upload", { method: "POST", body: form }); setFiles([]);
      }
      await refresh(); toast("已加入分析队列");
    } catch (error) { toast(error instanceof Error ? error.message : "提交失败", true); } finally { setSubmitting(false); }
  };
  const stop = async (videoId: string) => {
    try {
      await api(`/api/videos/${videoId}/stop`, { method: "POST" });
      await refresh();
      toast("分析已停止，已有本地文件会保留");
    } catch (error) {
      toast(error instanceof Error ? error.message : "停止失败", true);
    }
  };
  const removeFromQueue = async (video: VideoRecord) => {
    if (!window.confirm(`确定删除“${video.title || "这条视频"}”吗？报告、原视频、截图和片段都会一起删除，无法恢复。`)) return;
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      await refresh();
      toast("已从分析队列删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败", true);
    }
  };
  const queue = data.videos;
  return <><section className="page-heading"><div><span className="eyebrow">BATCH ANALYSIS</span><h1>批量拆解视频</h1><p>一次最多 10 条，后台按顺序处理，避免接口拥堵和重复花费。</p></div><div className="route-pill"><Sparkles />自动模型路由已开启</div></section><section className="ingest-layout"><div className="ingest-card"><div className="mode-tabs"><button className={mode === "links" ? "active" : ""} onClick={() => setMode("links")}><Link2 />TikTok 链接</button><button className={mode === "files" ? "active" : ""} onClick={() => setMode("files")}><Upload />上传本地视频</button></div><div className="product-select-label"><div className="product-select-heading"><span>存入产品档案</span><button type="button" onClick={() => setQuickProductOpen(true)}><Plus />新增产品</button></div><select value={productId} onChange={(e) => setProductId(e.target.value)}>{data.products.map((product) => <option key={product.id} value={product.id}>{product.name}{product.pid ? ` · PID ${product.pid}` : ""}</option>)}</select></div>{mode === "links" ? <div className="link-input-wrap"><textarea value={links} onChange={(e) => setLinks(e.target.value)} placeholder={"每行粘贴一条 TikTok 链接\nhttps://www.tiktok.com/t/..."} /><span>{parsedLinks.length}/10</span></div> : <label className="dropzone"><input type="file" multiple accept="video/*" onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 10))} /><Upload /><strong>{files.length ? `已选择 ${files.length} 个视频` : "点击选择视频"}</strong><span>支持 MP4、MOV、WEBM，单条最长 10 分钟</span>{files.map((file) => <em key={file.name}>{file.name}</em>)}</label>}<div className="ingest-footer"><div><CheckCircle2 /><span>原视频、截图和片段会长期保存到本机</span></div><button className="button primary large" disabled={submitting || !productId || (mode === "links" ? !parsedLinks.length || parsedLinks.length > 10 : !files.length)} onClick={submit}>{submitting ? <LoaderCircle className="spin" /> : <Sparkles />}开始分析</button></div></div><aside className="pipeline-card"><h3>自动处理流程</h3>{[[Link2, "获取原片", "TokScript 下载与公开数据"], [Languages, "识别文案", "英语 / 西语原文与中文翻译"], [ImageIcon, "逐镜头拆解", "清晰度、美感、光线与产品主体"], [Zap, "定位爆点", "钩子、卖点、信任点和 CTA"], [WandSparkles, "生成复拍稿", "新口播文案与分镜脚本"]].map(([Icon, title, text], index) => <div className="pipeline-step" key={String(title)}><span>{<Icon />}</span><i>{index + 1}</i><div><strong>{title as string}</strong><small>{text as string}</small></div></div>)}</aside></section><section className="section-block"><div className="section-heading"><div><h2>分析队列</h2><p>{queue.filter((v) => !["completed", "failed", "stopped", "waiting"].includes(v.status)).length} 条正在处理</p></div></div><div className="queue-list">{queue.length ? queue.map((video) => <div key={video.id} className="queue-row" role="button" tabIndex={0} onClick={() => onOpen(video)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(video); }}><VideoThumb video={video} compact /><div className="queue-main"><div><span className="product-pill">{video.productName}</span><strong>{video.title || video.sourceUrl}</strong><small>{video.sourceUrl || video.sourceFileName}</small></div><div className="queue-progress"><span>{video.stage}</span><div className="progress-track"><i style={{ width: `${video.progress}%` }} /></div>{video.errorMessage && <em>{video.errorMessage}</em>}</div></div><div className="queue-actions"><span className={`queue-status ${video.status}`}>{statusText[video.status]}</span>{["queued", "downloading", "transcribing", "extracting", "analyzing"].includes(video.status) && <button className="queue-stop" onClick={(event) => { event.stopPropagation(); void stop(video.id); }}><Square />停止</button>}{["waiting", "completed", "failed", "stopped"].includes(video.status) && <button className="queue-delete" onClick={(event) => { event.stopPropagation(); void removeFromQueue(video); }}><Trash2 />删除</button>}<ChevronRight /></div></div>) : <EmptyState icon={Clock3} title="队列是空的" text="提交链接或本地视频后，处理进度会显示在这里。" />}</div></section>{quickProductOpen && <QuickProductModal onClose={() => setQuickProductOpen(false)} onCreated={async (product) => { await refresh(); setProductId(product.id); setQuickProductOpen(false); }} toast={toast} />}</>;
}

function CompareView({ data, onOpen }: { data: DashboardPayload; onOpen: (video: VideoRecord) => void }) {
  const completed = data.videos.filter((video) => video.status === "completed");
  const [leftId, setLeftId] = useState(completed[0]?.id || "");
  const [rightId, setRightId] = useState(completed[1]?.id || "");
  const left = completed.find((video) => video.id === leftId);
  const right = completed.find((video) => video.id === rightId);
  const metrics: Array<[keyof VideoRecord["scores"], string]> = [["traffic", "流量潜力"], ["conversion", "带货转化"], ["visual", "画面质量"], ["product", "产品展示"], ["audio", "声音情绪"], ["rhythm", "节奏完播"]];
  return <><section className="page-heading"><div><span className="eyebrow">SIDE-BY-SIDE</span><h1>两条视频对比</h1><p>同产品或跨产品都能对比，快速找到值得复用的结构。</p></div></section>{completed.length < 2 ? <EmptyState icon={GitCompareArrows} title="至少需要两份完整报告" text="完成两条视频分析后，就能对比钩子、镜头、节奏和转化逻辑。" /> : <><div className="compare-pickers"><label>视频 A<select value={leftId} onChange={(e) => setLeftId(e.target.value)}>{completed.map((video) => <option key={video.id} value={video.id}>{video.productName} · {video.title}</option>)}</select></label><span>VS</span><label>视频 B<select value={rightId} onChange={(e) => setRightId(e.target.value)}>{completed.map((video) => <option key={video.id} value={video.id}>{video.productName} · {video.title}</option>)}</select></label></div>{left && right && <div className="compare-grid"><article className="compare-video"><VideoThumb video={left} /><div><span className="product-pill">{left.productName}</span><h3>{left.title}</h3><button className="text-button" onClick={() => onOpen(left)}>完整报告 <ChevronRight /></button></div></article><div className="compare-center"><div className="dual-radar"><Radar video={left} /><Radar video={right} color="#6d5dfc" /></div><div className="legend"><span><i className="coral-dot" />视频 A</span><span><i className="purple-dot" />视频 B</span></div></div><article className="compare-video right"><VideoThumb video={right} /><div><span className="product-pill">{right.productName}</span><h3>{right.title}</h3><button className="text-button" onClick={() => onOpen(right)}>完整报告 <ChevronRight /></button></div></article><section className="metric-compare span-3"><h3>六维评分对比</h3>{metrics.map(([key, label]) => <div className="metric-compare-row" key={key}><strong>{left.scores[key]}</strong><div className="bars"><div className="bar left"><i style={{ width: `${left.scores[key]}%` }} /></div><span>{label}</span><div className="bar right"><i style={{ width: `${right.scores[key]}%` }} /></div></div><strong>{right.scores[key]}</strong></div>)}</section><article className="compare-insight"><span className="insight-icon"><Zap /></span><h3>视频 A 的钩子</h3><p>{left.analysis?.hook.description || left.hookSummary}</p><small>{left.analysis?.hook.whyItWorks}</small></article><article className="compare-insight accent"><span className="insight-icon"><Zap /></span><h3>视频 B 的钩子</h3><p>{right.analysis?.hook.description || right.hookSummary}</p><small>{right.analysis?.hook.whyItWorks}</small></article><article className="compare-insight combined"><span className="insight-icon"><WandSparkles /></span><h3>组合复拍建议</h3><p>优先采用{left.scores.traffic >= right.scores.traffic ? "视频 A" : "视频 B"}的开场停留方式，再结合{left.scores.conversion >= right.scores.conversion ? "视频 A" : "视频 B"}的产品证明与行动号召。</p><small>{left.analysis?.structureFormula} × {right.analysis?.structureFormula}</small></article></div>}</>}</>;
}

function LearningPatternList({ title, items, empty }: { title: string; items: LearningProfile["insights"]["topHooks"]; empty: string }) {
  return <div className="learning-pattern-group"><strong>{title}</strong><div>{items.length ? items.map((item) => <span key={item.name}>{item.name}<em>{item.count}次</em></span>) : <small>{empty}</small>}</div></div>;
}

function LearningView({ onOpen }: { onOpen: (videoId: string) => void }) {
  const [learning, setLearning] = useState<LearningOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<LearningOverview>("/api/learning").then((result) => {
      if (!cancelled) setLearning(result);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "学习档案读取失败");
    });
    return () => { cancelled = true; };
  }, []);
  if (!learning) return <><section className="page-heading"><div><span className="eyebrow">CONTINUOUS LEARNING</span><h1>长期学习中心</h1><p>系统会把视频、真实表现和团队判断整合成可复用经验。</p></div></section><EmptyState icon={error ? AlertCircle : BrainCircuit} title={error || "正在整理历史经验"} text={error ? "请刷新页面重试。" : "首次进入会自动回填现有的完整报告。"} /></>;
  const global = learning.profiles.find((profile) => profile.scopeType === "global");
  const scoped = learning.profiles.filter((profile) => profile.scopeType !== "global");
  const outcomeText = { positive: "优质经验", neutral: "普通样本", negative: "反例经验", unverified: "待人工验证" };
  return <>
    <section className="page-heading learning-heading"><div><span className="eyebrow">CONTINUOUS LEARNING</span><h1>长期学习中心</h1><p>新视频会自动参考同产品、同品类和团队已验证的历史经验。</p></div><div className="learning-confidence"><span>当前可信度</span><strong>{learning.overallConfidence}%</strong></div></section>
    <div className="learning-metrics">
      <article><BrainCircuit /><div><strong>{learning.learnedVideos}</strong><span>已学习视频</span></div></article>
      <article><CheckCircle2 /><div><strong>{learning.labeledVideos}</strong><span>人工已校准</span></div></article>
      <article><Package /><div><strong>{learning.products}</strong><span>产品经验库</span></div></article>
      <article><FolderArchive /><div><strong>{learning.categories}</strong><span>品类经验库</span></div></article>
    </div>
    {learning.labeledVideos < 3 && <div className="learning-tip"><Lightbulb /><div><strong>再标记 {3 - learning.labeledVideos} 条视频，判断会更贴合团队标准</strong><p>人工“优质 / 普通 / 较差”和备注是最高权重证据；未标记案例只会低权重参考。</p></div></div>}
    <div className="learning-layout">
      <section className="learning-playbook">
        <div className="section-heading"><div><h2>全局经验手册</h2><p>{global ? `基于 ${global.sampleCount} 条视频持续更新` : "等待第一条完整报告"}</p></div></div>
        {global ? <div className="learning-patterns"><LearningPatternList title="有效钩子" items={global.insights.topHooks} empty="标记更多优质视频后形成规律" /><LearningPatternList title="高频爆点标签" items={global.insights.topTags} empty="暂无稳定标签" /><LearningPatternList title="胜出结构" items={global.insights.winningStructures} empty="暂无稳定结构" /><LearningPatternList title="已验证优点" items={global.insights.provenStrengths} empty="等待人工验证" /><LearningPatternList title="常见风险" items={global.insights.riskPatterns} empty="暂无反例规律" /></div> : <EmptyState icon={BrainCircuit} title="经验库还是空的" text="完成视频分析后会自动形成第一份经验。" />}
      </section>
      <section className="learning-scopes">
        <div className="section-heading"><div><h2>分层学习档案</h2><p>产品经验优先于品类经验，品类经验优先于全局经验</p></div></div>
        <div className="learning-scope-list">{scoped.length ? scoped.map((profile) => <article key={`${profile.scopeType}-${profile.scopeKey}`}><div className="scope-head"><span className={profile.scopeType}>{profile.scopeType === "product" ? <Package /> : <FolderArchive />}</span><div><small>{profile.scopeType === "product" ? "产品经验" : "品类经验"}</small><strong>{profile.scopeName}</strong></div><em>{profile.confidence}%</em></div><div className="scope-stats"><span>{profile.sampleCount} 条样本</span><span>{profile.positiveCount} 条优质</span><span>流量均分 {profile.averageTraffic}</span><span>转化均分 {profile.averageConversion}</span></div><div className="scope-hooks">{profile.insights.topHooks.slice(0, 3).map((item) => <span key={item.name}>{item.name}</span>)}</div></article>) : <p className="learning-empty">产品产生完整报告后，这里会出现专属经验档案。</p>}</div>
      </section>
    </div>
    <section className="section-block learning-recent"><div className="section-heading"><div><h2>最近吸收的经验</h2><p>点击可回看经验来源</p></div></div><div className="learning-memory-list">{learning.recentMemories.map((memory) => <button key={memory.videoId} onClick={() => onOpen(memory.videoId)}><span className={`memory-outcome ${memory.outcome}`}>{outcomeText[memory.outcome]}</span><div><strong>{memory.title}</strong><small>{memory.productName} · {memory.category || "未分类"}</small></div><div className="memory-rule"><span>{memory.hookType || "钩子待整理"}</span><p>{memory.structureFormula || "结构公式待整理"}</p></div><div className="memory-scores"><span>流量 {memory.traffic}</span><span>转化 {memory.conversion}</span></div><ChevronRight /></button>)}</div></section>
  </>;
}

function ProviderCard({ setting, refresh, toast }: { setting: ProviderSetting; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [apiKey, setApiKey] = useState(""); const [baseUrl, setBaseUrl] = useState(setting.baseUrl); const [model, setModel] = useState(setting.model); const [enabled, setEnabled] = useState(setting.enabled); const [busy, setBusy] = useState(false);
  const names = { tokscript: "TokScript MCP", openai: "OpenAI", qwen: "Qwen AI" };
  const details = { tokscript: "下载原片、封面、文案和公开数据", openai: "语音识别、关键帧分析与异常补位", qwen: "优先快速完成镜头拆解和中文报告" };
  const save = async () => { try { setBusy(true); await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: setting.provider, apiKey, baseUrl, model, enabled }) }); setApiKey(""); await refresh(); toast(`${names[setting.provider]} 设置已保存`); } catch (error) { toast(error instanceof Error ? error.message : "保存失败", true); } finally { setBusy(false); } };
  const test = async () => { try { setBusy(true); if (apiKey) await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: setting.provider, apiKey, baseUrl, model, enabled }) }); const result = await api<{ message: string }>("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: setting.provider }) }); setApiKey(""); await refresh(); toast(result.message); } catch (error) { toast(error instanceof Error ? error.message : "连接失败", true); } finally { setBusy(false); } };
  return <article className="provider-card"><div className="provider-heading"><span className={`provider-logo ${setting.provider}`}>{setting.provider === "tokscript" ? <Play /> : setting.provider === "openai" ? <Sparkles /> : <Zap />}</span><div><h3>{names[setting.provider]}</h3><p>{details[setting.provider]}</p></div><label className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span /></label></div><div className={`connection-state ${setting.hasKey ? "connected" : ""}`}><span />{setting.hasKey ? "已保存密钥" : "尚未配置"}</div><label>API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" placeholder={setting.hasKey ? "已安全保存，留空不修改" : "粘贴新的 API Key"} /></label><label>接口地址<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>{setting.provider !== "tokscript" && <label>模型名称<input value={model} onChange={(e) => setModel(e.target.value)} /></label>}<div className="provider-actions"><button className="button secondary" disabled={busy || (!setting.hasKey && !apiKey)} onClick={test}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}测试连接</button><button className="button primary" disabled={busy || !baseUrl} onClick={save}><Check />保存</button></div></article>;
}

function FeishuSettingsCard({ toast }: { toast: (message: string, error?: boolean) => void }) {
  const [settings, setSettings] = useState<FeishuSettings | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("http://localhost:3000");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await api<{ settings: FeishuSettings }>("/api/feishu/settings");
    setSettings(result.settings);
    setAppId(result.settings.appId);
    setPublicBaseUrl(result.settings.publicBaseUrl);
    setEnabled(result.settings.enabled);
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load().catch((error) => toast(error instanceof Error ? error.message : "读取飞书设置失败", true)), 0);
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load, toast]);
  const save = async () => {
    try {
      setBusy(true);
      const result = await api<{ settings: FeishuSettings }>("/api/feishu/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, appSecret, publicBaseUrl, enabled }),
      });
      setSettings(result.settings);
      setAppSecret("");
      toast(enabled ? "飞书机器人设置已保存并连接" : "飞书机器人已停用");
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存飞书设置失败", true);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      setBusy(true);
      if (appSecret || appId !== settings?.appId || enabled !== settings?.enabled || publicBaseUrl !== settings?.publicBaseUrl) {
        const saved = await api<{ settings: FeishuSettings }>("/api/feishu/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, appSecret, publicBaseUrl, enabled }),
        });
        setSettings(saved.settings);
        setAppSecret("");
      }
      const result = await api<{ message: string }>("/api/feishu/test", { method: "POST" });
      await load();
      toast(result.message);
    } catch (error) {
      toast(error instanceof Error ? error.message : "飞书连接失败", true);
    } finally {
      setBusy(false);
    }
  };
  const stateText = {
    connected: "长连接正常，正在监听飞书消息",
    connecting: "正在连接飞书",
    reconnecting: "连接中断，正在自动恢复",
    failed: settings?.lastError || "连接失败",
    disconnected: settings?.hasAppSecret ? "当前未连接" : "尚未配置",
  }[settings?.connectionStatus || "disconnected"];
  return <section className="feishu-settings-card"><div className="feishu-settings-head"><span className="feishu-logo"><Bot /></span><div><span className="eyebrow">FEISHU BOT</span><h2>飞书双向分析助手</h2><p>网页报告可以发送到飞书；单聊或群聊 @机器人并发送“产品名称 + TikTok 链接”，会自动分析并返回卡片和完整文档。</p></div><label className="switch"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span /></label></div><div className={`feishu-live ${settings?.connectionStatus || "disconnected"}`}><Radio /><div><strong>{stateText}</strong><small>{settings?.connectedAt ? `最近连接：${new Date(settings.connectedAt).toLocaleString("zh-CN")}` : "电脑关机或本工具未运行时，机器人将暂停接收消息。"}</small></div></div><div className="feishu-settings-grid"><div className="feishu-form"><label>App ID<input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_xxxxxxxxxx" /></label><label>App Secret<input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} autoComplete="off" placeholder={settings?.hasAppSecret ? "已加密保存，留空不修改" : "在这里填写，不要发到聊天中"} /></label><label>网页报告地址<input value={publicBaseUrl} onChange={(event) => setPublicBaseUrl(event.target.value)} placeholder="http://localhost:3000" /><small>目前本机运行可保持默认；迁移服务器后再改成服务器地址。</small></label><div className="provider-actions"><button className="button secondary" disabled={busy || !settings?.hasAppSecret && !appSecret} onClick={() => void test()}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}测试连接</button><button className="button primary" disabled={busy || !appId} onClick={() => void save()}><Check />保存飞书设置</button></div></div><div className="feishu-setup"><h3>飞书后台需要完成</h3><ol><li>创建企业自建应用，并启用机器人能力。</li><li>事件订阅选择“使用长连接接收事件”，添加“接收消息”。</li><li>回调配置添加“卡片回传交互”，用于优质/普通/较差和重新分析按钮。</li><li>开通消息、群信息、用户基本信息、新版文档、云空间文件、素材上传和协作者管理权限。</li><li>发布应用，并把机器人加入需要使用的群聊。</li></ol><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">打开飞书开放平台 <ExternalLink /></a></div></div>{settings?.rootFolderUrl && <div className="feishu-folder"><FolderArchive /><span>飞书报告已自动归档到“爆片分析报告 / 产品 / 年月”</span><a href={settings.rootFolderUrl} target="_blank" rel="noreferrer">打开文件夹</a></div>}</section>;
}

function SettingsView({ data, refresh, toast }: { data: DashboardPayload; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  return <><section className="page-heading"><div><span className="eyebrow">INTEGRATIONS</span><h1>接口与机器人设置</h1><p>配置分析模型和飞书机器人，保存后系统会自动完成消息接收、分析、归档与报告返回。</p></div></section><div className="security-banner"><AlertCircle /><div><strong>所有密钥都只在设置页面填写</strong><p>密钥会加密保存在本机，不写入源码。已经发到聊天里的旧密钥建议撤销并重新生成。</p></div></div><FeishuSettingsCard toast={toast} /><div className="provider-grid">{data.providers.map((setting) => <ProviderCard key={setting.provider} setting={setting} refresh={refresh} toast={toast} />)}</div><section className="routing-card"><div><span className="eyebrow">AUTO ROUTE</span><h2>自动分析路线</h2><p>TokScript 获取视频和数据后，Qwen 优先用关键帧与文案快速完成报告；OpenAI 负责本地视频语音识别，并在 Qwen 异常或结果不完整时自动补位。</p></div><div className="routing-flow"><span>TokScript</span><ArrowRight /><span>Qwen 优先</span><ArrowRight /><span>OpenAI 补位</span><ArrowRight /><strong>中文报告</strong></div></section></>;
}

function FeishuShareModal({ video, onClose, toast }: { video: VideoRecord; onClose: () => void; toast: (message: string, error?: boolean) => void }) {
  const [targets, setTargets] = useState<FeishuTarget[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    void api<{ targets: FeishuTarget[] }>("/api/feishu/targets").then((result) => {
      setTargets(result.targets);
      setSelected(result.targets[0]?.targetId || "");
    }).catch((error) => toast(error instanceof Error ? error.message : "读取飞书会话失败", true)).finally(() => setLoading(false));
  }, [toast]);
  const visible = targets.filter((target) => `${target.name} ${target.targetId}`.toLowerCase().includes(query.toLowerCase()));
  const send = async () => {
    try {
      setSending(true);
      const result = await api<{ message: string }>("/api/feishu/send", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videoId: video.id, targetId: selected }),
      });
      toast(result.message);
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", true);
    } finally {
      setSending(false);
    }
  };
  return <div className="modal-backdrop feishu-share-backdrop"><div className="modal feishu-share-modal"><div className="modal-title"><div><span className="eyebrow">SEND TO FEISHU</span><h2>发送报告到飞书</h2><p>{video.productName} · {video.title}</p></div><button type="button" onClick={onClose}><X /></button></div>{loading ? <div className="share-loading"><LoaderCircle className="spin" />正在读取最近会话</div> : targets.length ? <><div className="target-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索人或群聊" /></div><div className="target-list">{visible.map((target) => <button key={target.targetId} className={selected === target.targetId ? "active" : ""} onClick={() => setSelected(target.targetId)}><span>{target.targetType === "group" ? <Users /> : <Bot />}</span><div><strong>{target.name || (target.targetType === "group" ? "飞书群聊" : "飞书成员")}</strong><small>{target.targetType === "group" ? "群聊" : "单聊"} · 最近使用 {new Date(target.lastUsedAt).toLocaleDateString("zh-CN")}</small></div>{selected === target.targetId && <Check />}</button>)}</div><div className="modal-actions"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!selected || sending} onClick={() => void send()}>{sending ? <LoaderCircle className="spin" /> : <Send />}发送卡片和完整文档</button></div></> : <EmptyState icon={MessageCircle} title="还没有可发送的飞书会话" text="先在飞书中和机器人单聊，或把机器人加入群聊并 @它发送一次消息；之后这里就能选择该会话。" />}</div></div>;
}

function ReportModal({ id, data, onClose, refresh, toast }: { id: string; data: DashboardPayload; onClose: () => void; refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void }) {
  const [video, setVideo] = useState<VideoRecord | null>(null); const [tab, setTab] = useState<"overview" | "timeline" | "copy" | "remake">("overview"); const [notes, setNotes] = useState(""); const [shareOpen, setShareOpen] = useState(false);
  const load = useCallback(async () => { const result = await api<{ video: VideoRecord }>(`/api/videos/${id}`); setVideo(result.video); setNotes(result.video.manualNotes); }, [id]);
  useEffect(() => {
    let cancelled = false;
    void api<{ video: VideoRecord }>(`/api/videos/${id}`).then((result) => {
      if (cancelled) return;
      setVideo(result.video);
      setNotes(result.video.manualNotes);
    });
    return () => { cancelled = true; };
  }, [id]);
  const updateFeedback = async (manualLabel: string | null, manualNotes = notes, productId?: string) => { try { await api(`/api/videos/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manualLabel, manualNotes, productId }) }); await load(); await refresh(); toast("团队判断已保存"); } catch (error) { toast(error instanceof Error ? error.message : "保存失败", true); } };
  const reanalyze = async () => { try { await api(`/api/videos/${id}/analyze`, { method: "POST" }); await refresh(); onClose(); toast("已重新加入分析队列"); } catch (error) { toast(error instanceof Error ? error.message : "操作失败", true); } };
  const remove = async () => {
    if (!window.confirm("确定永久删除这条视频吗？报告、原视频、截图和爆点片段都会一起删除，无法恢复。")) return;
    try {
      await api(`/api/videos/${id}`, { method: "DELETE" });
      onClose();
      await refresh();
      toast("视频和全部分析文件已删除");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败", true);
    }
  };
  if (!video) return <div className="modal-backdrop"><div className="report-loading"><LoaderCircle className="spin" />正在读取报告</div></div>;
  const analysis = video.analysis;
  const media = mediaUrl(video.originalPath);
  return <div className="report-overlay"><div className="report"><header className="report-header"><button className="icon-button" onClick={onClose}><X /></button><div className="report-title"><span className="product-pill">{video.productName}</span><h2>{video.title || "视频分析报告"}</h2><p>@{video.accountName || "待获取账号"} · {formatDuration(video.durationSeconds)} · {video.language || "待识别语言"}</p></div><select value={video.productId} onChange={(e) => void updateFeedback(video.manualLabel, notes, e.target.value)}>{data.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>{video.status === "completed" && <button className="button feishu-send" onClick={() => setShareOpen(true)}><Send />发送到飞书</button>}<button className="button secondary" onClick={reanalyze}><RefreshCw />重新分析</button>{["completed", "failed", "stopped"].includes(video.status) && <button className="button danger" onClick={() => void remove()}><Trash2 />删除</button>}</header><div className="report-hero"><div className="report-player">{media ? <video controls poster={mediaUrl(video.coverPath)} src={media} /> : <VideoThumb video={video} />}<div className="player-stats"><span><Eye />{compactNumber(video.viewCount)}</span><span><Star />{compactNumber(video.likeCount)}</span><span><MessageCircle />{compactNumber(video.commentCount)}</span><span><Share2 />{compactNumber(video.shareCount)}</span><span><Bookmark />{compactNumber(video.favoriteCount)}</span></div></div><div className="report-summary"><div className="summary-scores"><ScoreRing value={video.scores.traffic} label="流量潜力" size="large" /><ScoreRing value={video.scores.conversion} label="带货转化" size="large" /></div><h3>{video.status === "completed" ? "核心判断" : video.stage}</h3><p>{video.summary || video.errorMessage || "分析正在进行，完成后这里会显示核心结论。"}</p>{analysis?.hook && <div className="hook-box"><span><Zap />{analysis.hook.timeRange} · {analysis.hook.type}</span><strong>{analysis.hook.description}</strong><p>{analysis.hook.whyItWorks}</p></div>}<div className="manual-rating"><span>团队人工判断</span>{["优质", "普通", "较差"].map((label) => <button key={label} className={video.manualLabel === label ? "active" : ""} onClick={() => void updateFeedback(label)}>{label === "优质" ? <Flame /> : label === "普通" ? <CircleGauge /> : <AlertCircle />}{label}</button>)}</div></div></div><nav className="report-tabs">{[["overview", "分析总览"], ["timeline", `逐镜头时间轴 ${video.scenes?.length || 0}`], ["copy", "原文案与翻译"], ["remake", "复拍脚本"]].map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</nav><div className="report-body">{tab === "overview" && <div className="overview-grid"><section className="report-card span-2"><div className="card-title"><span><BarChart3 />六维诊断</span></div><div className="score-diagnostics">{[["流量潜力", video.scores.traffic], ["带货转化", video.scores.conversion], ["画面质量", video.scores.visual], ["产品展示", video.scores.product], ["声音情绪", video.scores.audio], ["节奏完播", video.scores.rhythm]].map(([label, score]) => <div key={String(label)}><span>{label}</span><div className="diagnostic-track"><i className={scoreTone(Number(score))} style={{ width: `${score}%` }} /></div><strong>{score}</strong></div>)}</div></section><section className="report-card"><div className="card-title"><span><Flame />爆点定位</span></div>{analysis?.viralPoints?.length ? analysis.viralPoints.map((point) => <div className="viral-point" key={`${point.timeRange}-${point.description}`}><strong>{point.timeRange}</strong><div><b>{point.description}</b><p>{point.reason}</p></div></div>) : <p className="muted">暂无爆点数据</p>}</section><section className="report-card"><div className="card-title"><span><CheckCircle2 />拍得好的地方</span></div><ul className="analysis-list good">{analysis?.strengths?.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="report-card"><div className="card-title"><span><AlertCircle />需要改进</span></div><ul className="analysis-list bad">{analysis?.weaknesses?.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="report-card span-2 formula"><span className="eyebrow">VIRAL FORMULA</span><h3>爆款结构公式</h3><p>{analysis?.structureFormula || "等待分析"}</p></section></div>}{tab === "timeline" && <div className="timeline-list">{video.scenes?.map((scene) => <SceneCard key={scene.id} scene={scene} />)}</div>}{tab === "copy" && <div className="copy-grid"><section className="report-card"><div className="card-title"><span><Volume2 />原语言文案</span><em>{video.language || "英语 / 西语"}</em></div><p className="transcript">{video.transcriptOriginal || "暂无原文"}</p></section><section className="report-card"><div className="card-title"><span><Languages />中文翻译</span></div><p className="transcript">{video.transcriptZh || "等待翻译"}</p></section></div>}{tab === "remake" && <div className="remake-grid"><section className="report-card"><div className="card-title"><span><WandSparkles />AI 仿写口播稿</span></div><p className="transcript remake-copy">{analysis?.rewriteScript || "等待分析"}</p></section><section className="report-card"><div className="card-title"><span><FileVideo2 />可复拍分镜</span></div><div className="storyboard-list">{analysis?.storyboard?.map((item, index) => <div key={`${item.shot}-${index}`}><span>{index + 1}</span><div><strong>{item.shot}</strong><p>{item.visual}</p><em>{item.voiceover}</em></div></div>)}</div></section></div>}<section className="feedback-box"><label>团队备注<textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="记录为什么判断它优质、普通或较差，后续同产品分析会参考。" /></label><button className="button primary" onClick={() => void updateFeedback(video.manualLabel)}>保存备注</button></section></div></div>{shareOpen && <FeishuShareModal video={video} onClose={() => setShareOpen(false)} toast={toast} />}</div>;
}

function SceneCard({ scene }: { scene: SceneRecord }) {
  return <article className="scene-card"><div className="scene-index"><strong>{String(scene.shotIndex).padStart(2, "0")}</strong><span>{formatDuration(scene.startSeconds)}–{formatDuration(scene.endSeconds)}</span></div><div className="scene-media"><img src={mediaUrl(scene.screenshotPath)} alt={`镜头 ${scene.shotIndex}`} />{scene.clipPath && <video controls src={mediaUrl(scene.clipPath)} poster={mediaUrl(scene.screenshotPath)} />}</div><div className="scene-copy"><div className="scene-role"><strong>{scene.role}</strong><div>{scene.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><p>{scene.visualDescription}</p><div className="scene-voice"><Volume2 /><span>{scene.transcriptOriginal || scene.audioDescription}<em>{scene.translationZh}</em></span></div><div className="scene-notes"><p><CheckCircle2 />{scene.strengths || "—"}</p><p><AlertCircle />{scene.weaknesses || "—"}</p></div></div><div className="scene-scores">{[["流量", scene.scoreTraffic], ["转化", scene.scoreConversion], ["清晰", scene.scoreClarity], ["美感", scene.scoreAesthetic], ["光线", scene.scoreLighting], ["产品", scene.scoreProduct]].map(([label, score]) => <div key={String(label)}><span>{label}</span><strong>{score}</strong></div>)}</div></article>;
}

export default function ViralAnalyzerApp() {
  const [view, setView] = useState<ViewName>("dashboard"); const [data, setData] = useState<DashboardPayload | null>(null); const [search, setSearch] = useState(""); const [openVideoId, setOpenVideoId] = useState<string | null>(null); const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null); const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => { const params = new URLSearchParams(); if (search) params.set("search", search); const result = await api<DashboardPayload>(`/api/dashboard?${params}`); setData(result); }, [search]);
  useEffect(() => { if (searchTimer.current) clearTimeout(searchTimer.current); searchTimer.current = setTimeout(() => void refresh().catch((error) => setNotice({ message: error.message, error: true })), 180); return () => { if (searchTimer.current) clearTimeout(searchTimer.current); }; }, [refresh]);
  useEffect(() => { const timer = setInterval(() => { if (data?.totals.processing) void refresh(); }, 3000); return () => clearInterval(timer); }, [data?.totals.processing, refresh]);
  useEffect(() => { const timer = window.setTimeout(() => { const videoId = new URLSearchParams(window.location.search).get("video"); if (videoId) setOpenVideoId(videoId); }, 0); return () => window.clearTimeout(timer); }, []);
  const toast = useCallback((message: string, error = false) => { setNotice({ message, error }); setTimeout(() => setNotice(null), 4200); }, []);
  if (!data) return <div className="app-loading"><span className="brand-mark"><Flame /></span><LoaderCircle className="spin" /><p>正在打开爆片分析…</p></div>;
  return <AppShell view={view} setView={setView} data={data} search={search} setSearch={setSearch}>{view === "dashboard" && <DashboardView data={data} onOpen={(video) => setOpenVideoId(video.id)} setView={setView} />}{view === "products" && <ProductsView data={data} refresh={refresh} toast={toast} />}{view === "analyze" && <AnalyzeView data={data} refresh={refresh} toast={toast} onOpen={(video) => setOpenVideoId(video.id)} />}{view === "compare" && <CompareView data={data} onOpen={(video) => setOpenVideoId(video.id)} />}{view === "learning" && <LearningView onOpen={(videoId) => setOpenVideoId(videoId)} />}{view === "settings" && <SettingsView data={data} refresh={refresh} toast={toast} />}{openVideoId && <ReportModal id={openVideoId} data={data} onClose={() => setOpenVideoId(null)} refresh={refresh} toast={toast} />}{notice && <div className={`toast ${notice.error ? "error" : ""}`}>{notice.error ? <AlertCircle /> : <CheckCircle2 />}{notice.message}</div>}</AppShell>;
}
