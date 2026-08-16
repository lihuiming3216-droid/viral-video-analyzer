import "server-only";

import { getProduct, getVideo, replaceScenes, updateVideo } from "@/lib/database";
import { clampScore, formatTime } from "@/lib/json-utils";
import { getLearningContext, learnFromVideo } from "@/lib/learning";
import { getProviderConfig } from "@/lib/provider-config";
import { analyzeVideoWithQwen, transcribeAudioWithQwen } from "@/lib/providers/qwen";
import { fetchTikTok, tokScriptTranscriptFailure } from "@/lib/providers/tokscript";
import type { AnalysisResult, AnalysisScene, Product, ScoreSet } from "@/lib/types";
import { transcriptAndTranslationAgree } from "@/lib/transcript-validation";
import { emitVideoProgress } from "@/lib/video-events";
import {
  createSceneClip,
  downloadMedia,
  extractVideoAssets,
  resolveMediaPath,
  splitAudioForQwenAsr,
  type ExtractedScene,
} from "@/lib/video-processing";

function setStage(id: string, status: string, stage: string, progress: number) {
  updateVideo(id, { status, stage, progress, error_message: null });
  emitVideoProgress(id);
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function defaultScores(): ScoreSet {
  return { traffic: 0, conversion: 0, visual: 0, product: 0, audio: 0, rhythm: 0 };
}

function normalizeScene(value: Partial<AnalysisScene>, shotIndex: number): AnalysisScene {
  return {
    shotIndex,
    role: String(value.role || "内容推进"),
    visual: String(value.visual || ""),
    audio: String(value.audio || ""),
    originalText: String(value.originalText || ""),
    translationZh: String(value.translationZh || ""),
    good: String(value.good || ""),
    improve: String(value.improve || ""),
    importance: clampScore(value.importance),
    scoreTraffic: clampScore(value.scoreTraffic),
    scoreConversion: clampScore(value.scoreConversion),
    scoreClarity: clampScore(value.scoreClarity),
    scoreAesthetic: clampScore(value.scoreAesthetic),
    scoreLighting: clampScore(value.scoreLighting),
    scoreProduct: clampScore(value.scoreProduct),
    tags: stringArray(value.tags),
  };
}

function normalizeAnalysis(value: Partial<AnalysisResult>, sceneCount: number, trace: string[]): AnalysisResult {
  const rawScores = value.scores || defaultScores();
  const rawScenes = Array.isArray(value.scenes) ? value.scenes : [];
  const scenes = Array.from({ length: sceneCount }, (_, index) => {
    const matched = rawScenes.find((scene) => Number(scene.shotIndex) === index + 1) || rawScenes[index] || {};
    return normalizeScene(matched, index + 1);
  });
  return {
    summary: String(value.summary || "分析已完成"),
    language: String(value.language || "unknown"),
    translationZh: String(value.translationZh || ""),
    scores: {
      traffic: clampScore(rawScores.traffic), conversion: clampScore(rawScores.conversion),
      visual: clampScore(rawScores.visual), product: clampScore(rawScores.product),
      audio: clampScore(rawScores.audio), rhythm: clampScore(rawScores.rhythm),
    },
    hook: {
      timeRange: String(value.hook?.timeRange || "00:00–00:03"),
      type: String(value.hook?.type || "开场钩子"),
      description: String(value.hook?.description || ""),
      whyItWorks: String(value.hook?.whyItWorks || ""),
    },
    viralPoints: Array.isArray(value.viralPoints)
      ? value.viralPoints.map((point) => ({ timeRange: String(point.timeRange || ""), description: String(point.description || ""), reason: String(point.reason || "") }))
      : [],
    strengths: stringArray(value.strengths),
    weaknesses: stringArray(value.weaknesses),
    structureFormula: String(value.structureFormula || ""),
    rewriteScript: String(value.rewriteScript || ""),
    storyboard: Array.isArray(value.storyboard)
      ? value.storyboard.map((item) => ({ shot: String(item.shot || ""), visual: String(item.visual || ""), voiceover: String(item.voiceover || "") }))
      : [],
    scenes,
    modelTrace: trace,
  };
}

function buildPrompt(input: {
  product: Product;
  scenes: ExtractedScene[];
  transcript: string;
  transcriptSegments: Array<{ start: number; end: number; text: string }>;
  learningContext: unknown;
  mode: "full" | "product_doc";
}) {
  const timeline = input.scenes.map((scene) => ({
    shotIndex: scene.shotIndex,
    timeRange: `${formatTime(scene.startSeconds)}–${formatTime(scene.endSeconds)}`,
  }));
  if (input.mode === "product_doc") {
    const productContext = {
      name: input.product.name,
      pid: input.product.pid,
      coreFunctions: input.product.coreFunctions.slice(0, 3),
      usageMethod: input.product.usageMethod,
      targetAudience: input.product.targetAudience,
      usageScenes: input.product.usageScenes,
    };
    return `你是 TikTok 带货短视频拆解专家。请用中文输出极简的产品样片分析。

只输出：核心判断、开头钩子、分析爆点、内容结构、产品呈现、用户痛点或情绪、转化方式、可借鉴点，以及完整的中文口播翻译。不要输出评分、原视频链接、复拍口播稿或分镜脚本。不要臆造页面或视频没有提供的信息。
除 translationZh 外，所有分析都用短语，不写解释句；只保留“动作+结果”。summary 不超过30个汉字；hook.description、每条 viralPoints、strengths 和 structureFormula 均不超过18个汉字。删除“通过、进行、能够、可以、有效提升、有助于、让用户”等套话。
translationZh 必须是完整原口播的自然中文翻译，不要只翻译其中几句；听不清的部分标记为“[听不清]”。
如果视频没有口播，translationZh 必须写“无口播”，仍需根据画面完成其余分析。
严格使用以下 JSON 结构：{"summary":"","language":"","translationZh":"","hook":{"timeRange":"","type":"","description":"","whyItWorks":""},"viralPoints":[{"timeRange":"","description":"","reason":""}],"strengths":[""],"structureFormula":""}。

产品：${JSON.stringify(productContext)}
镜头时间轴：${JSON.stringify(timeline)}
带时间码原文：${JSON.stringify(input.transcriptSegments)}
完整原文：${input.transcript}`;
  }
  return `你是 TikTok 带货短视频拆解专家。请用中文输出，原文案保留英语或西语，并逐段给出中文翻译。translationZh 字段必须给出完整口播的中文翻译。

目标：分别判断流量潜力和带货转化，不要因为播放量高就默认转化高。分析每个镜头的画面、声音、清晰度、美感、光线、产品主体是否清晰、节奏、情绪和商业作用。

必须识别并标记：0–3 秒钩子、爆点、卖点、信任点、CTA。说明哪里拍得好、为什么有效、哪里需要改。分数均为 0–100。

评分口径：
- 流量：首屏停留、好奇、反差、节奏、信息密度、情绪与完播潜力。
- 转化：产品露出、痛点匹配、利益清晰度、演示说服力、信任、异议处理与 CTA。
- 画面：清晰度、美感、构图、光线、主体分离、字幕可读性。
- 声音：口播清楚度、情绪、音乐和音效对节奏的帮助。

严格按提供的 shotIndex 输出同样数量的 scenes，不增加、不遗漏、不改时间顺序。图片顺序与 shotIndex 一致。

产品：${JSON.stringify(input.product)}
镜头时间轴：${JSON.stringify(timeline)}
带时间码原文：${JSON.stringify(input.transcriptSegments)}
完整原文：${input.transcript}
长期学习系统提供的产品/品类/团队历史经验：${JSON.stringify(input.learningContext)}

历史经验只能用于校准判断和识别可复用规律，不能机械沿用旧分数。人工标签和团队备注的优先级高于未验证案例。

最后生成一份吸收原片优点、但不是逐句抄袭的中文复拍口播稿和分镜脚本。`;
}

function isConfigured(provider: "qwen") {
  const config = getProviderConfig(provider);
  return config.enabled && Boolean(config.apiKey);
}

function transientNetworkFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(?:timeout|timed out|aborted due to timeout|fetch failed|econnreset|etimedout|socket|und_err)/i.test(message);
}

async function withOneNetworkRetry<T>(
  operation: () => Promise<T>,
  onRetry: () => void,
  signal?: AbortSignal,
) {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted || !transientNetworkFailure(error)) throw error;
    onRetry();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    signal?.throwIfAborted();
    return operation();
  }
}

function userFacingAnalysisError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (transientNetworkFailure(error)) {
    return "获取 TikTok 视频超时，系统已自动重试一次；请稍后在分析状态栏输入“重试”再次处理";
  }
  return message;
}

function isUsableAnalysis(
  value: Record<string, unknown> | undefined,
  sceneCount: number,
  mode: "full" | "product_doc",
  transcript = "",
) {
  if (!value || typeof value.summary !== "string" || !value.summary.trim()) return false;
  if (!transcriptAndTranslationAgree(transcript, value.translationZh)) return false;
  const scores = value.scores;
  const scenes = value.scenes;
  // The table path deliberately asks for a compact object without scene rows
  // or scores. Accept it here so a valid lightweight result does not trigger
  // a second Qwen request.
  if (mode === "product_doc") return typeof value.translationZh === "string" && Boolean(value.translationZh.trim());
  return Boolean(
    scores && typeof scores === "object"
    && Array.isArray(scenes)
    && scenes.length >= sceneCount,
  );
}

function transcriptForScene(
  scene: ExtractedScene,
  segments: Array<{ start: number; end: number; text: string }>,
  fallback: string,
) {
  if (!segments.length) return fallback;
  return segments
    .filter((segment) => segment.end >= scene.startSeconds && segment.start <= scene.endSeconds)
    .map((segment) => segment.text)
    .join(" ");
}

export async function analyzeVideo(videoId: string, signal?: AbortSignal) {
  const initial = getVideo(videoId);
  if (!initial) throw new Error("视频不存在");
  const product = getProduct(initial.productId);
  if (!product) throw new Error("产品档案不存在");
  const analysisMode = initial.analysisMode;
  const trace: string[] = [];
  try {
    signal?.throwIfAborted();
    let relativeVideoPath = initial.originalPath;
    let remoteVideoUrl = initial.remoteVideoUrl;
    let transcript = initial.transcriptOriginal;
    let transcriptSegments: Array<{ start: number; end: number; text: string }> = [];

    const storedTokScriptFailure = initial.sourceType === "tiktok"
      && tokScriptTranscriptFailure(transcript);
    const needsTokScriptRefresh = initial.sourceType === "tiktok"
      && (!relativeVideoPath || !transcript.trim() || storedTokScriptFailure);
    if (needsTokScriptRefresh) {
      setStage(videoId, "downloading", "正在通过 TokScript 获取视频和公开数据", 12);
      const tokOptions = {
        includeCover: analysisMode !== "product_doc",
        // One bad/expired document link must never block every later row.
        timeoutMs: analysisMode === "product_doc" ? 90_000 : 180_000,
      };
      const tok = await withOneNetworkRetry(
        () => fetchTikTok(initial.sourceUrl || "", signal, tokOptions),
        () => setStage(videoId, "downloading", "获取视频信息较慢，正在自动重试", 14),
        signal,
      );
      if (!tok.downloadUrl) throw new Error("TokScript 没有返回可下载的视频地址");
      remoteVideoUrl = tok.downloadUrl;
      transcript = tok.transcript;
      transcriptSegments = tok.segments;
      // Persist metadata before downloading the media. If the CDN is slow, a
      // retry keeps the already-fetched transcript and diagnostics instead of
      // losing the whole TokScript result.
      updateVideo(videoId, {
        remote_video_url: remoteVideoUrl,
        transcript_original: transcript,
        transcript_segments_json: JSON.stringify(transcriptSegments),
        language: tok.language || null,
        title: tok.title || initial.title,
        account_name: tok.accountName,
        platform_video_id: tok.platformVideoId || null,
        published_at: tok.publishedAt,
        view_count: tok.stats.views,
        like_count: tok.stats.likes,
        comment_count: tok.stats.comments,
        share_count: tok.stats.shares,
        favorite_count: tok.stats.favorites,
        follower_count: tok.stats.followers,
        stats_captured_at: new Date().toISOString(),
        provider_payload_json: JSON.stringify(tok.raw),
      });
      trace.push(relativeVideoPath
        ? "TokScript：已刷新先前无效的口播响应"
        : "TokScript：视频、文案与公开数据");
      if (!relativeVideoPath) {
        setStage(videoId, "downloading", "正在下载 TikTok 原视频", 22);
        relativeVideoPath = await withOneNetworkRetry(
          () => downloadMedia(videoId, tok.downloadUrl, "video", signal, {
            timeoutMs: analysisMode === "product_doc" ? 90_000 : 180_000,
          }),
          () => setStage(videoId, "downloading", "原视频下载较慢，正在自动重试", 24),
          signal,
        );
        const coverPath = tok.coverUrl ? await downloadMedia(videoId, tok.coverUrl, "cover", signal).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        }) : null;
        updateVideo(videoId, { original_path: relativeVideoPath, cover_path: coverPath });
      }
    } else if (initial.sourceType === "tiktok") {
      trace.push("本地缓存：复用已保存的 TikTok 原片和文案");
    }

    if (!relativeVideoPath) throw new Error("没有可分析的视频文件");
    setStage(videoId, "extracting", "正在识别镜头并提取关键画面", 36);
    const assets = await extractVideoAssets(videoId, relativeVideoPath, signal, {
      light: analysisMode === "product_doc",
      // TokScript is the sole transcript source for TikTok links. Never
      // re-transcribe the downloaded TikTok file with a second provider.
      // Local uploads still need audio extraction because they have no
      // TokScript transcript request.
      includeAudio: initial.sourceType !== "tiktok" && !transcript,
    });
    updateVideo(videoId, {
      duration_seconds: assets.duration,
      cover_path: getVideo(videoId, false)?.coverPath || assets.scenes[0]?.screenshotPath || null,
    });

    if (initial.sourceType !== "tiktok" && !transcript && assets.audioPath) {
      if (!isConfigured("qwen")) {
        throw new Error("本地上传视频需要配置 Qwen 才能识别口播");
      }
      setStage(videoId, "transcribing", "正在识别英语或西语口播", 52);
      const audioChunks = await splitAudioForQwenAsr(assets.audioPath, assets.duration, signal);
      const transcripts: string[] = [];
      for (const chunk of audioChunks) {
        signal?.throwIfAborted();
        transcripts.push(await transcribeAudioWithQwen(resolveMediaPath(chunk), signal));
      }
      transcript = transcripts.join(" ").trim();
      updateVideo(videoId, { transcript_original: transcript });
      trace.push("Qwen：本地上传视频语音识别");
    }

    const learningContext = analysisMode === "product_doc" ? null : getLearningContext(product, videoId);
    const learnedExamples = Array.isArray(learningContext?.similarExamples) ? learningContext.similarExamples.length : 0;
    if (learnedExamples) trace.push(`长期学习：参考 ${learnedExamples} 条相似历史经验`);
    const prompt = buildPrompt({ product, scenes: assets.scenes, transcript, transcriptSegments, learningContext, mode: analysisMode });
    const framePaths = assets.scenes.map((scene) => resolveMediaPath(scene.screenshotPath));
    setStage(videoId, "analyzing", "正在分析画面、声音、钩子和转化结构", 66);

    let qwenContext: Record<string, unknown> | undefined;
    if (isConfigured("qwen")) {
      try {
        qwenContext = await analyzeVideoWithQwen({
          prompt,
          remoteVideoUrl,
          framePaths,
          maxTokens: analysisMode === "product_doc" ? 2_000 : 4_500,
          signal,
        });
        trace.push("Qwen：关键帧、文案与镜头结构分析");
      } catch (error) {
        if (signal?.aborted) throw error;
        trace.push(`Qwen 初审未采用：${error instanceof Error ? error.message : "未知错误"}`);
      }
    }

    setStage(videoId, "analyzing", analysisMode === "product_doc" ? "正在生成轻量视频分析和中文翻译" : "正在生成中文深度报告和复拍脚本", 82);
    let rawAnalysis: Partial<AnalysisResult>;
    if (isUsableAnalysis(qwenContext, assets.scenes.length, analysisMode, transcript)) {
      rawAnalysis = qwenContext as Partial<AnalysisResult>;
      trace.push("自动路由：Qwen 结果完整，直接生成快速报告");
    } else if (isConfigured("qwen")) {
      try {
        rawAnalysis = await analyzeVideoWithQwen({ prompt, remoteVideoUrl, framePaths, maxTokens: analysisMode === "product_doc" ? 2_000 : 4_500, signal });
        trace.push("Qwen：首次结果不完整，已重试一次");
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!qwenContext) throw error;
        rawAnalysis = qwenContext as Partial<AnalysisResult>;
      }
    } else {
      throw new Error("请先配置并启用 Qwen，所有 AI 分析只使用 Qwen");
    }

    if (!isUsableAnalysis(rawAnalysis as Record<string, unknown>, assets.scenes.length, analysisMode, transcript)) {
      throw new Error("Qwen 未返回完整的视频分析和中文翻译，请重试该链接");
    }

    const analysis = normalizeAnalysis(rawAnalysis, assets.scenes.length, trace);
    const keyShotIndexes = new Set<number>();
    analysis.scenes.forEach((scene) => {
      if (scene.tags.some((tag) => /钩子|爆点|hook|viral/i.test(tag)) || /钩子|爆点/.test(scene.role)) keyShotIndexes.add(scene.shotIndex);
    });
    if (!keyShotIndexes.size && analysis.scenes.length) {
      keyShotIndexes.add(1);
      const best = [...analysis.scenes].sort((a, b) => b.importance - a.importance)[0];
      if (best) keyShotIndexes.add(best.shotIndex);
    }

    const sceneRows = [];
    for (const base of assets.scenes) {
      signal?.throwIfAborted();
      const result = analysis.scenes[base.shotIndex - 1];
      let clipPath: string | null = null;
      if (analysisMode !== "product_doc" && keyShotIndexes.has(base.shotIndex) && keyShotIndexes.size <= 6) {
        clipPath = await createSceneClip(videoId, relativeVideoPath, base.startSeconds, base.endSeconds, `shot-${base.shotIndex}`, signal).catch((error) => {
          if (signal?.aborted) throw error;
          return null;
        });
      }
      sceneRows.push({
        shotIndex: base.shotIndex,
        startSeconds: base.startSeconds,
        endSeconds: base.endSeconds,
        screenshotPath: base.screenshotPath,
        clipPath,
        role: result.role,
        visualDescription: result.visual,
        audioDescription: result.audio,
        transcriptOriginal: result.originalText || transcriptForScene(base, transcriptSegments, ""),
        translationZh: result.translationZh,
        strengths: result.good,
        weaknesses: result.improve,
        importance: result.importance,
        scoreTraffic: result.scoreTraffic,
        scoreConversion: result.scoreConversion,
        scoreClarity: result.scoreClarity,
        scoreAesthetic: result.scoreAesthetic,
        scoreLighting: result.scoreLighting,
        scoreProduct: result.scoreProduct,
        tags: result.tags,
      });
    }
    signal?.throwIfAborted();
    replaceScenes(videoId, sceneRows);
    updateVideo(videoId, {
      status: "completed",
      stage: "分析完成",
      progress: 100,
      score_traffic: analysis.scores.traffic,
      score_conversion: analysis.scores.conversion,
      score_visual: analysis.scores.visual,
      score_product: analysis.scores.product,
      score_audio: analysis.scores.audio,
      score_rhythm: analysis.scores.rhythm,
      summary: analysis.summary,
      hook_summary: analysis.hook.description,
      transcript_zh: analysis.translationZh || analysis.scenes.map((scene) => scene.translationZh).filter(Boolean).join(" "),
      analysis_json: JSON.stringify(analysis),
      error_message: null,
    });
    // Push the finished result into the matching row immediately. The periodic
    // document scan remains only a safety net and is not the normal delivery
    // path for newly completed videos.
    await import("@/lib/feishu/product-doc-sync")
      .then(({ syncCompletedVideoToProductDocument }) => syncCompletedVideoToProductDocument(videoId))
      .catch(() => false);
    // A video created by a Feishu Base automation carries a pending job. Push
    // the compact result back to that exact record after analysis completes.
    void import("@/lib/feishu/automation")
      .then(({ completeFeishuAutomation }) => completeFeishuAutomation(videoId))
      .catch(() => undefined);
    emitVideoProgress(videoId);
    try {
      learnFromVideo(videoId);
    } catch {
      // 学习档案失败不能影响已经完成的视频报告。
    }
  } catch (error) {
    updateVideo(videoId, {
      status: signal?.aborted ? "stopped" : "failed",
      stage: signal?.aborted ? "已停止" : "分析失败",
      error_message: signal?.aborted ? null : userFacingAnalysisError(error),
    });
    void import("@/lib/feishu/automation")
      .then(({ completeFeishuAutomation }) => completeFeishuAutomation(videoId))
      .catch(() => undefined);
    emitVideoProgress(videoId);
    throw error;
  }
}
