export const NO_PRODUCT_VOICEOVER_TRANSCRIPT = "背景音乐，无有效产品口播";

/** True when a model answer explicitly claims that the video has no speech. */
export function translationClaimsNoVoiceover(value: unknown) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  return /^(?:(?:该|此)?视频(?:中)?(?:没有|无)(?:任何)?(?:口播|旁白|语音)(?:内容)?|(?:没有|无)(?:任何)?(?:口播|旁白|语音)(?:内容)?|no (?:spoken )?(?:audio|speech|voice[ -]?over|narration))(?:[，,。.!！;；]|$)/i.test(normalized);
}

/** A nonempty TokScript transcript cannot be translated as “no voiceover”. */
export function transcriptAndTranslationAgree(transcript: unknown, translation: unknown) {
  const normalizedTranscript = String(transcript || "").normalize("NFKC").trim();
  return !normalizedTranscript
    || normalizedTranscript === NO_PRODUCT_VOICEOVER_TRANSCRIPT.normalize("NFKC")
    || !translationClaimsNoVoiceover(translation);
}
