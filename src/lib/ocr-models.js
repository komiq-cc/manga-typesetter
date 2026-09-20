// OCR recognizers a user may choose for each project language. The project
// stores only its language; these are machine preferences so one installation
// can favour quality while another favours download size and speed.

export const OCR_MODEL_OPTIONS = Object.freeze({
  ja: Object.freeze([
    Object.freeze({
      id: 'manga-ocr',
      label: 'Manga OCR',
      detail: 'Japanese manga specialist',
    }),
  ]),
  zh: Object.freeze([
    Object.freeze({
      id: 'ppocrv6-medium',
      label: 'PP-OCRv6 Medium',
      detail: 'Quality · multilingual · 73 MB',
    }),
    Object.freeze({
      id: 'ch-ppocrv5-server',
      label: 'PP-OCRv5 Server',
      detail: 'Chinese-focused · 81 MB',
    }),
    Object.freeze({
      id: 'ch-ppocrv5-mobile',
      label: 'PP-OCRv5 Mobile',
      detail: 'Compact · 16 MB',
    }),
  ]),
  ko: Object.freeze([
    Object.freeze({
      id: 'ko-ppocrv5-mobile',
      label: 'PP-OCRv5 Korean',
      detail: 'Recommended · Korean-specific · 13 MB',
    }),
    Object.freeze({
      id: 'ko-ppocrv4-mobile',
      label: 'PP-OCRv4 Korean',
      detail: 'Legacy fallback · Korean-specific · 23 MB',
    }),
  ]),
});

export const DEFAULT_OCR_MODELS = Object.freeze({
  ja: 'manga-ocr',
  zh: 'ppocrv6-medium',
  ko: 'ko-ppocrv5-mobile',
});

export function normalizeOcrModels(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const language of Object.keys(DEFAULT_OCR_MODELS)) {
    const requested = source[language];
    out[language] = OCR_MODEL_OPTIONS[language].some((model) => model.id === requested)
      ? requested
      : DEFAULT_OCR_MODELS[language];
  }
  return out;
}

export function ocrModelForLanguage(language, selections) {
  const normalized = normalizeOcrModels(selections);
  return normalized[language] ?? DEFAULT_OCR_MODELS.ja;
}
