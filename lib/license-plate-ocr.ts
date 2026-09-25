import type { TextRecognitionResult } from "@react-native-ml-kit/text-recognition";
import { isValidSpanishPlate, normalizeSpanishPlate } from "./license-plate";

export type PlateCandidateSource =
  | "full-text"
  | "block"
  | "line"
  | "element";

export interface SpanishPlateCandidate {
  plate: string;
  source: PlateCandidateSource;
  sourceText: string;
  corrections: number;
  exact: boolean;
}

const OCR_DIGIT_CORRECTIONS: Record<string, string> = {
  O: "0",
  Q: "0",
};

/**
 * Compacta el texto OCR dejando únicamente letras y números.
 */
function compactAlphaNumeric(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Genera variantes de una ventana de 7 caracteres.
 *
 * Solo corregimos posiciones que deben ser numéricas.
 * Las posiciones de letras NO se corrigen.
 */
function normalizeOcrWindow(window: string): Array<{
  plate: string;
  corrections: number;
}> {
  if (window.length !== 7) {
    return [];
  }

  const chars = window.toUpperCase().split("");
  let corrections = 0;

  for (let i = 0; i < 4; i++) {
    const corrected = OCR_DIGIT_CORRECTIONS[chars[i]];

    if (corrected) {
      chars[i] = corrected;
      corrections++;
    }
  }

  const plate = normalizeSpanishPlate(chars.join(""));

  if (!isValidSpanishPlate(plate)) {
    return [];
  }

  return [
    {
      plate,
      corrections,
    },
  ];
}

function findCandidatesInText(
  text: string,
  source: PlateCandidateSource
): SpanishPlateCandidate[] {
  const compact = compactAlphaNumeric(text);

  if (compact.length < 7) {
    return [];
  }

  const candidates: SpanishPlateCandidate[] = [];

  for (let i = 0; i <= compact.length - 7; i++) {
    const window = compact.slice(i, i + 7);

    // Primero comprobamos coincidencia exacta.
    if (isValidSpanishPlate(window)) {
      candidates.push({
        plate: window,
        source,
        sourceText: text,
        corrections: 0,
        exact: true,
      });

      continue;
    }

    // Después probamos correcciones OCR conservadoras.
    for (const normalized of normalizeOcrWindow(window)) {
      candidates.push({
        plate: normalized.plate,
        source,
        sourceText: text,
        corrections: normalized.corrections,
        exact: normalized.corrections === 0,
      });
    }
  }

  return candidates;
}

function collectOcrTexts(result: TextRecognitionResult): Array<{
  text: string;
  source: PlateCandidateSource;
}> {
  const texts: Array<{
    text: string;
    source: PlateCandidateSource;
  }> = [];

  if (result.text) {
    texts.push({
      text: result.text,
      source: "full-text",
    });
  }

  for (const block of result.blocks ?? []) {
    if (block.text) {
      texts.push({
        text: block.text,
        source: "block",
      });
    }

    for (const line of block.lines ?? []) {
      if (line.text) {
        texts.push({
          text: line.text,
          source: "line",
        });
      }

      for (const element of line.elements ?? []) {
        if (element.text) {
          texts.push({
            text: element.text,
            source: "element",
          });
        }
      }
    }
  }

  return texts;
}

function candidateScore(candidate: SpanishPlateCandidate): number {
  let score = 0;

  if (candidate.exact) {
    score += 100;
  }

  if (candidate.source === "line") {
    score += 30;
  } else if (candidate.source === "element") {
    score += 25;
  } else if (candidate.source === "block") {
    score += 20;
  } else {
    score += 10;
  }

  score -= candidate.corrections * 20;

  return score;
}

/**
 * Extrae la mejor matrícula española candidata del resultado de ML Kit.
 *
 * Devuelve null cuando no existe ningún candidato que cumpla
 * estrictamente el formato español.
 */
export function extractSpanishPlateFromOcr(
  result: TextRecognitionResult
): SpanishPlateCandidate | null {
  const candidates = collectOcrTexts(result)
    .flatMap(({ text, source }) => findCandidatesInText(text, source));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const scoreDifference = candidateScore(b) - candidateScore(a);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return a.corrections - b.corrections;
  });

  return candidates[0];
}
