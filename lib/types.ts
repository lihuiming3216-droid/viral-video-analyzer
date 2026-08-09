export type ProviderName = "tokscript" | "qwen";

export type VideoStatus =
  | "waiting"
  | "queued"
  | "downloading"
  | "transcribing"
  | "extracting"
  | "analyzing"
  | "completed"
  | "stopped"
  | "failed";

export type ManualLabel = "优质" | "普通" | "较差" | null;

export interface Product {
  id: string;
  name: string;
  pid: string;
  sku: string;
  documentId: string | null;
  documentUrl: string | null;
  imagePath: string | null;
  /** Employee-entered prop images for the product document. */
  propImages: string[];
  category: string;
  market: string;
  price: string;
  sellingPoints: string;
  targetAudience: string;
  painPoints: string;
  competitors: string;
  productUrl: string;
  coreFunctions: string[];
  productParameters: string;
  usageMethod: string;
  usageScenes: string;
  sourceTitle: string;
  sourceDescription: string;
  /** Public product images discovered from the source page. */
  sourceImageUrls: string[];
  /** Short list of product details that were confirmed from images. */
  visualEvidence: string;
  visualAnalysisStatus: "" | "completed" | "unavailable";
  /** Cache marker: a PID is visually analyzed at most once unless forced. */
  visualAnalyzedAt: string | null;
  bannedTerms: string;
  notes: string;
  isSystem: boolean;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreSet {
  traffic: number;
  conversion: number;
  visual: number;
  product: number;
  audio: number;
  rhythm: number;
}

export interface VideoRecord {
  id: string;
  productId: string;
  productName: string;
  sourceType: "tiktok" | "upload";
  sourceUrl: string | null;
  sourceFileName: string | null;
  title: string;
  accountName: string;
  platformVideoId: string | null;
  language: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  originalPath: string | null;
  coverPath: string | null;
  remoteVideoUrl: string | null;
  status: VideoStatus;
  stage: string;
  progress: number;
  errorMessage: string | null;
  scores: ScoreSet;
  summary: string;
  hookSummary: string;
  manualLabel: ManualLabel;
  manualNotes: string;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  favoriteCount: number | null;
  followerCount: number | null;
  statsCapturedAt: string | null;
  transcriptOriginal: string;
  transcriptZh: string;
  analysis: AnalysisResult | null;
  createdAt: string;
  updatedAt: string;
  scenes?: SceneRecord[];
  analysisMode: "full" | "product_doc";
}

export interface SceneRecord {
  id: string;
  videoId: string;
  shotIndex: number;
  startSeconds: number;
  endSeconds: number;
  screenshotPath: string | null;
  clipPath: string | null;
  role: string;
  visualDescription: string;
  audioDescription: string;
  transcriptOriginal: string;
  translationZh: string;
  strengths: string;
  weaknesses: string;
  importance: number;
  scoreTraffic: number;
  scoreConversion: number;
  scoreClarity: number;
  scoreAesthetic: number;
  scoreLighting: number;
  scoreProduct: number;
  tags: string[];
}

export interface AnalysisScene {
  shotIndex: number;
  role: string;
  visual: string;
  audio: string;
  originalText: string;
  translationZh: string;
  good: string;
  improve: string;
  importance: number;
  scoreTraffic: number;
  scoreConversion: number;
  scoreClarity: number;
  scoreAesthetic: number;
  scoreLighting: number;
  scoreProduct: number;
  tags: string[];
}

export interface AnalysisResult {
  summary: string;
  language: string;
  /** Full Chinese translation used by Feishu's lightweight table output. */
  translationZh: string;
  scores: ScoreSet;
  hook: {
    timeRange: string;
    type: string;
    description: string;
    whyItWorks: string;
  };
  viralPoints: Array<{
    timeRange: string;
    description: string;
    reason: string;
  }>;
  strengths: string[];
  weaknesses: string[];
  structureFormula: string;
  rewriteScript: string;
  storyboard: Array<{
    shot: string;
    visual: string;
    voiceover: string;
  }>;
  scenes: AnalysisScene[];
  modelTrace?: string[];
}

export interface ProviderSetting {
  provider: ProviderName;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  enabled: boolean;
  updatedAt: string;
}

export type LearningScopeType = "global" | "category" | "product";

export interface LearningPattern {
  name: string;
  count: number;
  score: number;
}

export interface LearningProfile {
  scopeType: LearningScopeType;
  scopeKey: string;
  scopeName: string;
  sampleCount: number;
  labeledCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  averageTraffic: number;
  averageConversion: number;
  confidence: number;
  insights: {
    topHooks: LearningPattern[];
    topTags: LearningPattern[];
    winningStructures: LearningPattern[];
    provenStrengths: LearningPattern[];
    riskPatterns: LearningPattern[];
  };
  updatedAt: string;
}

export interface LearningOverview {
  learnedVideos: number;
  labeledVideos: number;
  positiveVideos: number;
  categories: number;
  products: number;
  overallConfidence: number;
  profiles: LearningProfile[];
  recentMemories: Array<{
    videoId: string;
    title: string;
    productName: string;
    category: string;
    outcome: "positive" | "neutral" | "negative" | "unverified";
    manualLabel: ManualLabel;
    hookType: string;
    structureFormula: string;
    traffic: number;
    conversion: number;
    updatedAt: string;
  }>;
}

export interface DashboardPayload {
  products: Product[];
  videos: VideoRecord[];
  providers: ProviderSetting[];
  totals: {
    products: number;
    videos: number;
    completed: number;
    processing: number;
    averageTraffic: number;
    averageConversion: number;
  };
}

export type FeishuConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export interface FeishuSettings {
  appId: string;
  hasAppSecret: boolean;
  enabled: boolean;
  publicBaseUrl: string;
  rootFolderToken: string;
  rootFolderUrl: string;
  connectionStatus: FeishuConnectionState;
  lastError: string;
  connectedAt: string | null;
  updatedAt: string;
}

export interface FeishuTarget {
  targetId: string;
  targetType: "p2p" | "group";
  name: string;
  senderOpenId: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuDelivery {
  id: string;
  videoId: string;
  batchId: string | null;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  replyToMessageId: string | null;
  cardMessageId: string | null;
  documentId: string | null;
  documentUrl: string | null;
  source: "inbound" | "web";
  status: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}
