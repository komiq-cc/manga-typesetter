import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OCR_MODELS,
  OCR_MODEL_OPTIONS,
  normalizeOcrModels,
  ocrModelForLanguage,
} from './ocr-models.js';

describe('OCR model preferences', () => {
  it('defaults Chinese and Korean to the quality model', () => {
    expect(normalizeOcrModels(null)).toEqual({
      ja: 'manga-ocr',
      zh: 'ppocrv6-medium',
      ko: 'ko-ppocrv5-mobile',
    });
  });

  it('keeps only models offered for that language', () => {
    expect(
      normalizeOcrModels({
        ja: 'ppocrv6-medium',
        zh: 'ch-ppocrv5-server',
        ko: 'ch-ppocrv5-mobile',
      }),
    ).toEqual({
      ja: DEFAULT_OCR_MODELS.ja,
      zh: 'ch-ppocrv5-server',
      ko: DEFAULT_OCR_MODELS.ko,
    });
  });

  it('migrates the old unsupported Korean PP-OCRv6 choice to Korean PP-OCRv5', () => {
    expect(normalizeOcrModels({ ko: 'ppocrv6-medium' }).ko).toBe('ko-ppocrv5-mobile');
    expect(normalizeOcrModels({ ko: 'ppocrv6-small' }).ko).toBe('ko-ppocrv5-mobile');
  });

  it('resolves the model sent with each project language', () => {
    const selected = { ja: 'manga-ocr', zh: 'ch-ppocrv5-mobile', ko: 'ko-ppocrv4-mobile' };
    expect(ocrModelForLanguage('zh', selected)).toBe('ch-ppocrv5-mobile');
    expect(ocrModelForLanguage('ko', selected)).toBe('ko-ppocrv4-mobile');
    expect(ocrModelForLanguage('unknown', selected)).toBe('manga-ocr');
    expect(OCR_MODEL_OPTIONS.zh.map((model) => model.id)).toContain('ch-ppocrv5-server');
  });
});
