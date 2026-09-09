import { DEFAULT_PROMPT_TEMPLATES, PROMPT_TEMPLATE_LABELS, PROMPT_TEMPLATE_SLUGS } from "@/lib/analysis";
import { getPromptTemplate, listPromptDebugCaptures, type PromptTemplate } from "@/lib/database";
import {
  DEFAULT_SEGMENT_TRANSLATION_TEMPLATE, DEFAULT_TRANSCRIPT_TRANSLATION_TEMPLATE,
  SEGMENT_TRANSLATION_PROMPT_SLUG, TRANSCRIPT_TRANSLATION_PROMPT_SLUG,
} from "@/lib/providers/qwen";
import { AdminTopbar } from "../AdminTopbar";
import { PromptWorkspace } from "./PromptWorkspace";

export const dynamic = "force-dynamic";

const TEMPLATE_ORDER: Array<{ slug: string; label: string; defaultTemplate: string; source: string }> = [
  { slug: PROMPT_TEMPLATE_SLUGS.full, label: PROMPT_TEMPLATE_LABELS.full, defaultTemplate: DEFAULT_PROMPT_TEMPLATES.full, source: "lib/analysis.ts · analyzeVideo() · full 模式" },
  { slug: PROMPT_TEMPLATE_SLUGS.product_doc, label: PROMPT_TEMPLATE_LABELS.product_doc, defaultTemplate: DEFAULT_PROMPT_TEMPLATES.product_doc, source: "lib/analysis.ts · analyzeVideo() · product_doc 模式" },
  { slug: TRANSCRIPT_TRANSLATION_PROMPT_SLUG, label: "口播翻译", defaultTemplate: DEFAULT_TRANSCRIPT_TRANSLATION_TEMPLATE, source: "lib/providers/qwen.ts · translateTranscriptWithQwen()" },
  { slug: SEGMENT_TRANSLATION_PROMPT_SLUG, label: "分段口播翻译（字幕用）", defaultTemplate: DEFAULT_SEGMENT_TRANSLATION_TEMPLATE, source: "lib/providers/qwen.ts · translateSegmentsWithQwen()" },
];

export default async function AdminPromptsPage({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const { slug: requestedSlug } = await searchParams;
  const activeMeta = TEMPLATE_ORDER.find((item) => item.slug === requestedSlug) || TEMPLATE_ORDER[0];

  const templates: PromptTemplate[] = await Promise.all(
    TEMPLATE_ORDER.map((item) => getPromptTemplate(item.slug, item.label, item.defaultTemplate)),
  );
  const activeTemplate = templates.find((item) => item.slug === activeMeta.slug)!;
  const isTranslation = activeMeta.slug === TRANSCRIPT_TRANSLATION_PROMPT_SLUG;
  const captures = isTranslation ? [] : await listPromptDebugCaptures(activeMeta.slug, 30);

  return (
    <>
      <AdminTopbar title="Prompt 调试台" />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: 250, flex: "0 0 250px", borderRight: "1px solid var(--border)", padding: "14px 10px", overflow: "auto" }}>
          <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-faint)", padding: "6px 8px 10px" }}>提示词模板</div>
          <div style={{ display: "grid", gap: 2 }}>
            {TEMPLATE_ORDER.map((item) => {
              const active = item.slug === activeMeta.slug;
              return (
                <a
                  key={item.slug}
                  href={`/admin/prompts?slug=${item.slug}`}
                  style={{
                    display: "flex", flexDirection: "column", gap: 5, padding: "12px 14px", borderRadius: 10,
                    background: active ? "var(--surface-2)" : "transparent",
                    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--text)" : "var(--text-muted)" }}>{item.label}</span>
                  <span style={{ fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>v{templates.find((t) => t.slug === item.slug)?.currentVersion ?? 1}</span>
                </a>
              );
            })}
          </div>
        </div>

        <PromptWorkspace
          slug={activeMeta.slug}
          label={activeMeta.label}
          source={activeMeta.source}
          currentVersion={activeTemplate.currentVersion}
          updatedAt={activeTemplate.updatedAt}
          initialTemplate={activeTemplate.template}
          captures={captures}
          isTranslation={isTranslation}
        />
      </div>
    </>
  );
}
