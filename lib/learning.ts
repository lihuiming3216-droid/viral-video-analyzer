import "server-only";

import { getDb, getProduct, getVideo } from "@/lib/database";
import type {
  AnalysisResult,
  LearningOverview,
  LearningPattern,
  LearningProfile,
  LearningScopeType,
  ManualLabel,
  Product,
  ScoreSet,
} from "@/lib/types";

type Outcome = "positive" | "neutral" | "negative" | "unverified";

type MemoryFeatures = {
  title: string;
  productName: string;
  manualLabel: ManualLabel;
  manualNotes: string;
  hookType: string;
  hookDescription: string;
  hookReason: string;
  structureFormula: string;
  strengths: string[];
  weaknesses: string[];
  tags: string[];
  summary: string;
  scores: ScoreSet;
  stats: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
};

type MemoryRow = {
  video_id: string;
  product_id: string;
  category: string;
  outcome: Outcome;
  evidence_weight: number;
  features_json: string;
  updated_at: string;
  product_name?: string;
  video_title?: string;
};

const emptyInsights: LearningProfile["insights"] = {
  topHooks: [],
  topTags: [],
  winningStructures: [],
  provenStrengths: [],
  riskPatterns: [],
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function outcomeFor(label: ManualLabel): Outcome {
  if (label === "优质") return "positive";
  if (label === "普通") return "neutral";
  if (label === "较差") return "negative";
  return "unverified";
}

function evidenceWeight(outcome: Outcome) {
  return outcome === "positive" || outcome === "negative" ? 1 : outcome === "neutral" ? 0.75 : 0.35;
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value]).map(String).map((value) => value.trim()).filter(Boolean))];
}

function featuresFromAnalysis(input: {
  title: string;
  productName: string;
  manualLabel: ManualLabel;
  manualNotes: string;
  analysis: AnalysisResult;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
}): MemoryFeatures {
  return {
    title: input.title,
    productName: input.productName,
    manualLabel: input.manualLabel,
    manualNotes: input.manualNotes,
    hookType: input.analysis.hook.type,
    hookDescription: input.analysis.hook.description,
    hookReason: input.analysis.hook.whyItWorks,
    structureFormula: input.analysis.structureFormula,
    strengths: uniqueStrings(input.analysis.strengths),
    weaknesses: uniqueStrings(input.analysis.weaknesses),
    tags: uniqueStrings(input.analysis.scenes.map((scene) => scene.tags)),
    summary: input.analysis.summary,
    scores: input.analysis.scores,
    stats: {
      views: input.viewCount,
      likes: input.likeCount,
      comments: input.commentCount,
      shares: input.shareCount,
    },
  };
}

export function learnFromVideo(videoId: string, refreshProfiles = true) {
  const video = getVideo(videoId, false);
  if (!video || video.status !== "completed" || !video.analysis) return false;
  const product = getProduct(video.productId);
  if (!product) return false;
  const outcome = outcomeFor(video.manualLabel);
  const features = featuresFromAnalysis({
    title: video.title,
    productName: product.name,
    manualLabel: video.manualLabel,
    manualNotes: video.manualNotes,
    analysis: video.analysis,
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    commentCount: video.commentCount,
    shareCount: video.shareCount,
  });
  const timestamp = new Date().toISOString();
  const searchableText = uniqueStrings([
    features.title, features.productName, product.category, product.pid, features.manualNotes,
    features.hookType, features.hookDescription, features.structureFormula,
    features.strengths, features.weaknesses, features.tags, features.summary,
  ]).join(" ");
  getDb().prepare(`INSERT INTO learning_memories(
    video_id, product_id, category, outcome, evidence_weight, features_json, searchable_text,
    source_updated_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(video_id) DO UPDATE SET
    product_id=excluded.product_id,
    category=excluded.category,
    outcome=excluded.outcome,
    evidence_weight=excluded.evidence_weight,
    features_json=excluded.features_json,
    searchable_text=excluded.searchable_text,
    source_updated_at=excluded.source_updated_at,
    updated_at=excluded.updated_at`).run(
    video.id, product.id, product.category || "未分类", outcome, evidenceWeight(outcome),
    JSON.stringify(features), searchableText, video.updatedAt, timestamp, timestamp,
  );
  if (refreshProfiles) refreshLearningProfiles();
  return true;
}

export function syncLearningMemories() {
  const rows = getDb().prepare(`SELECT v.id FROM videos v
    LEFT JOIN learning_memories m ON m.video_id=v.id
    WHERE v.status='completed' AND v.analysis_json IS NOT NULL
      AND (m.video_id IS NULL OR m.source_updated_at <> v.updated_at)`).all() as Array<{ id: string }>;
  rows.forEach((row) => learnFromVideo(String(row.id), false));
  if (rows.length || !getDb().prepare("SELECT 1 FROM learning_profiles LIMIT 1").get()) refreshLearningProfiles();
  return rows.length;
}

function rankedPatterns(values: Array<{ names: string[]; score: number }>, limit = 5): LearningPattern[] {
  const totals = new Map<string, { count: number; score: number }>();
  values.forEach(({ names, score }) => {
    uniqueStrings(names).forEach((name) => {
      const current = totals.get(name) || { count: 0, score: 0 };
      current.count += 1;
      current.score += score;
      totals.set(name, current);
    });
  });
  return [...totals.entries()]
    .filter(([, value]) => value.score > 0)
    .sort((a, b) => b[1].score - a[1].score || b[1].count - a[1].count)
    .slice(0, limit)
    .map(([name, value]) => ({ name, count: value.count, score: Number(value.score.toFixed(2)) }));
}

function buildProfile(scopeType: LearningScopeType, scopeKey: string, scopeName: string, rows: MemoryRow[]): LearningProfile {
  const memories = rows.map((row) => ({ row, features: parseJson<MemoryFeatures>(row.features_json, {} as MemoryFeatures) }));
  const labeled = memories.filter(({ row }) => row.outcome !== "unverified");
  const average = (key: keyof ScoreSet) => memories.length
    ? Math.round(memories.reduce((sum, item) => sum + Number(item.features.scores?.[key] || 0), 0) / memories.length)
    : 0;
  const positiveSignal = (row: MemoryRow) => row.evidence_weight * (
    row.outcome === "positive" ? 2 : row.outcome === "neutral" ? 0.7 : row.outcome === "unverified" ? 0.3 : -0.8
  );
  const riskSignal = (row: MemoryRow) => row.evidence_weight * (
    row.outcome === "negative" ? 2 : row.outcome === "neutral" ? 0.6 : row.outcome === "unverified" ? 0.25 : 0.15
  );
  const profile: LearningProfile = {
    scopeType,
    scopeKey,
    scopeName,
    sampleCount: memories.length,
    labeledCount: labeled.length,
    positiveCount: memories.filter(({ row }) => row.outcome === "positive").length,
    neutralCount: memories.filter(({ row }) => row.outcome === "neutral").length,
    negativeCount: memories.filter(({ row }) => row.outcome === "negative").length,
    averageTraffic: average("traffic"),
    averageConversion: average("conversion"),
    confidence: Math.min(100, Math.round(labeled.length * 14 + (memories.length - labeled.length) * 3)),
    insights: {
      topHooks: rankedPatterns(memories.map(({ row, features }) => ({ names: [features.hookType], score: positiveSignal(row) }))),
      topTags: rankedPatterns(memories.map(({ row, features }) => ({ names: features.tags || [], score: positiveSignal(row) })), 8),
      winningStructures: rankedPatterns(memories.map(({ row, features }) => ({ names: [features.structureFormula], score: positiveSignal(row) })), 4),
      provenStrengths: rankedPatterns(memories.map(({ row, features }) => ({ names: features.strengths || [], score: positiveSignal(row) })), 5),
      riskPatterns: rankedPatterns(memories.map(({ row, features }) => ({ names: features.weaknesses || [], score: riskSignal(row) })), 5),
    },
    updatedAt: new Date().toISOString(),
  };
  return profile;
}

export function refreshLearningProfiles() {
  const db = getDb();
  const rows = db.prepare(`SELECT m.*, p.name AS product_name FROM learning_memories m
    JOIN products p ON p.id=m.product_id ORDER BY m.updated_at DESC`).all() as MemoryRow[];
  const scopes = new Map<string, { type: LearningScopeType; key: string; name: string; rows: MemoryRow[] }>();
  const add = (type: LearningScopeType, key: string, name: string, row: MemoryRow) => {
    const id = `${type}:${key}`;
    const scope = scopes.get(id) || { type, key, name, rows: [] };
    scope.rows.push(row);
    scopes.set(id, scope);
  };
  rows.forEach((row) => {
    add("global", "all", "全部视频", row);
    add("category", row.category || "未分类", row.category || "未分类", row);
    add("product", row.product_id, row.product_name || "未命名产品", row);
  });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM learning_profiles").run();
    const insert = db.prepare(`INSERT INTO learning_profiles(
      scope_type, scope_key, sample_count, labeled_count, positive_count, neutral_count, negative_count,
      avg_traffic, avg_conversion, confidence, insights_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    scopes.forEach((scope) => {
      const profile = buildProfile(scope.type, scope.key, scope.name, scope.rows);
      insert.run(
        profile.scopeType, profile.scopeKey, profile.sampleCount, profile.labeledCount,
        profile.positiveCount, profile.neutralCount, profile.negativeCount,
        profile.averageTraffic, profile.averageConversion, profile.confidence,
        JSON.stringify({ ...profile.insights, scopeName: profile.scopeName }), profile.updatedAt,
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return scopes.size;
}

function profileFromRow(row: Record<string, unknown>): LearningProfile {
  const payload = parseJson<LearningProfile["insights"] & { scopeName?: string }>(row.insights_json, emptyInsights);
  return {
    scopeType: String(row.scope_type) as LearningScopeType,
    scopeKey: String(row.scope_key),
    scopeName: payload.scopeName || String(row.scope_key),
    sampleCount: Number(row.sample_count || 0),
    labeledCount: Number(row.labeled_count || 0),
    positiveCount: Number(row.positive_count || 0),
    neutralCount: Number(row.neutral_count || 0),
    negativeCount: Number(row.negative_count || 0),
    averageTraffic: Number(row.avg_traffic || 0),
    averageConversion: Number(row.avg_conversion || 0),
    confidence: Number(row.confidence || 0),
    insights: {
      topHooks: payload.topHooks || [],
      topTags: payload.topTags || [],
      winningStructures: payload.winningStructures || [],
      provenStrengths: payload.provenStrengths || [],
      riskPatterns: payload.riskPatterns || [],
    },
    updatedAt: String(row.updated_at),
  };
}

export function getLearningOverview(): LearningOverview {
  syncLearningMemories();
  const db = getDb();
  const profiles = (db.prepare(`SELECT * FROM learning_profiles
    ORDER BY CASE scope_type WHEN 'global' THEN 0 WHEN 'product' THEN 1 ELSE 2 END, sample_count DESC`).all() as Array<Record<string, unknown>>)
    .map(profileFromRow);
  const memories = db.prepare(`SELECT m.*, p.name AS product_name, v.title AS video_title, v.manual_label
    FROM learning_memories m JOIN products p ON p.id=m.product_id JOIN videos v ON v.id=m.video_id
    ORDER BY m.updated_at DESC LIMIT 12`).all() as Array<MemoryRow & { manual_label?: string }>;
  const global = profiles.find((profile) => profile.scopeType === "global");
  return {
    learnedVideos: global?.sampleCount || 0,
    labeledVideos: global?.labeledCount || 0,
    positiveVideos: global?.positiveCount || 0,
    categories: profiles.filter((profile) => profile.scopeType === "category").length,
    products: profiles.filter((profile) => profile.scopeType === "product").length,
    overallConfidence: global?.confidence || 0,
    profiles,
    recentMemories: memories.map((row) => {
      const features = parseJson<MemoryFeatures>(row.features_json, {} as MemoryFeatures);
      return {
        videoId: row.video_id,
        title: row.video_title || features.title || "未命名视频",
        productName: row.product_name || features.productName || "未命名产品",
        category: row.category,
        outcome: row.outcome,
        manualLabel: (row.manual_label || null) as ManualLabel,
        hookType: features.hookType || "",
        structureFormula: features.structureFormula || "",
        traffic: Number(features.scores?.traffic || 0),
        conversion: Number(features.scores?.conversion || 0),
        updatedAt: row.updated_at,
      };
    }),
  };
}

export function getLearningContext(product: Product, excludeVideoId = "") {
  syncLearningMemories();
  const rows = getDb().prepare(`SELECT m.*, p.name AS product_name, v.title AS video_title
    FROM learning_memories m JOIN products p ON p.id=m.product_id JOIN videos v ON v.id=m.video_id
    WHERE m.video_id <> ? AND (m.product_id=? OR m.category=? OR m.outcome='positive')
    ORDER BY CASE WHEN m.product_id=? THEN 0 WHEN m.category=? THEN 1 ELSE 2 END,
      CASE m.outcome WHEN 'positive' THEN 0 WHEN 'neutral' THEN 1 WHEN 'unverified' THEN 2 ELSE 3 END,
      m.updated_at DESC LIMIT 12`).all(
    excludeVideoId, product.id, product.category || "未分类", product.id, product.category || "未分类",
  ) as MemoryRow[];
  const profiles = (getDb().prepare(`SELECT * FROM learning_profiles WHERE
    (scope_type='global' AND scope_key='all') OR
    (scope_type='category' AND scope_key=?) OR
    (scope_type='product' AND scope_key=?)`).all(product.category || "未分类", product.id) as Array<Record<string, unknown>>)
    .map(profileFromRow);
  return {
    rule: "人工标签和备注是最高优先级证据；未标记案例仅作低置信度参考。不要机械复制历史分数。",
    profiles,
    similarExamples: rows.map((row) => ({
      videoId: row.video_id,
      scope: row.product_id === product.id ? "同产品" : row.category === (product.category || "未分类") ? "同品类" : "跨品类优质案例",
      outcome: row.outcome,
      evidenceWeight: row.evidence_weight,
      features: parseJson<MemoryFeatures>(row.features_json, {} as MemoryFeatures),
    })),
  };
}

export function refreshProductLearning(productId: string) {
  const rows = getDb().prepare("SELECT id FROM videos WHERE product_id=? AND status='completed'").all(productId) as Array<{ id: string }>;
  rows.forEach((row) => learnFromVideo(String(row.id), false));
  refreshLearningProfiles();
}
