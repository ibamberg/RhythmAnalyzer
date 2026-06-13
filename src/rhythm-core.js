import { APP_CONFIG } from "./config.js";
import { classifyDuration } from "./durations.js";
import { getBeatBoundaries, getMeterConfig } from "./meter.js";
import {
  getPositionTolerance,
  hitMsFromPosition,
  positionFromHitMs,
  quantizeHitPositions,
  sanitizeHits
} from "./pass-utils.js";
import { clamp, round } from "./utils.js";

const EPSILON = 0.000001;

// Главный поток анализа: из записанных проходов строит статус, уверенность и эталон.
export function analyzeRhythm(input) {
  const meter = getMeterConfig(input.meter);
  const passes = prepareAnalysisPasses(input.passes);
  const analyzedPasses = passes.map((pass) => analyzePass(pass, meter));

  if (!hasEnoughPasses(analyzedPasses)) {
    return buildCollectingResult(meter, analyzedPasses);
  }

  const tolerance = calculateAdaptiveTolerance(analyzedPasses, meter);
  const referencePass = findReferencePass(analyzedPasses, tolerance);
  const comparedPasses = comparePassesToReference(analyzedPasses, referencePass, tolerance);

  return buildAnalysisResult(meter, comparedPasses, referencePass);
}

// Анализирует один проход: время удара -> позиция -> привязанная позиция -> длительности.
export function analyzePass(pass, meter) {
  const hitsMs = sanitizeHits(pass.hitsMs, pass.durationMs);
  const tolerance = getPositionTolerance(pass.durationMs, meter.unitsPerPass);
  const normalizedHits = buildNormalizedHits(hitsMs, pass.durationMs, meter);
  const rawElements = buildNoteElements(normalizedHits, meter, pass.durationMs, tolerance);
  const elements = spellTupletDurations(rawElements, meter);

  return {
    index: pass.index,
    durationMs: pass.durationMs,
    hitsMs,
    normalizedHits,
    elements,
    confidence: calculatePassConfidence(normalizedHits, elements, tolerance),
    similarityToReference: null
  };
}

function buildNoteElements(normalizedHits, meter, passDurationMs, tolerance) {
  const boundaries = getBeatBoundaries(meter);
  const elements = [];

  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const windowStart = boundaries[boundaryIndex];
    const windowEnd = boundaries[boundaryIndex + 1];
    const windowHits = normalizedHits.filter(
      (hit) =>
        hit.quantizedPosition >= windowStart - EPSILON &&
        hit.quantizedPosition < windowEnd - EPSILON
    );

    for (let hitIndex = 0; hitIndex < windowHits.length; hitIndex += 1) {
      const hit = windowHits[hitIndex];
      const nextHit = windowHits[hitIndex + 1];
      const toPosition = nextHit ? nextHit.quantizedPosition : windowEnd;
      const value = Math.max(0, toPosition - hit.quantizedPosition);

      if (value <= EPSILON) {
        continue;
      }

      const durationInfo = classifyDuration(value, meter, tolerance);

      elements.push({
        type: "note",
        duration: durationInfo.duration,
        value: round(value, 4),
        fromPosition: round(hit.quantizedPosition, 4),
        toPosition: round(toPosition, 4),
        fromMs: round(hitMsFromPosition(hit.quantizedPosition, passDurationMs, meter), 3),
        toMs: round(hitMsFromPosition(toPosition, passDurationMs, meter), 3),
        confidence: round(durationInfo.confidence, 4)
      });
    }
  }

  return elements;
}

function calculateAdaptiveTolerance(passes, meter) {
  if (!passes.length) {
    return APP_CONFIG.analysis.adaptiveToleranceRatio;
  }

  const averageDurationMs =
    passes.reduce((sum, pass) => sum + pass.durationMs, 0) / passes.length;

  return getPositionTolerance(averageDurationMs, meter.unitsPerPass);
}

// Сравнивает два проанализированных прохода по привязанным позициям и возвращает 0..1.
export function comparePasses(referencePass, candidatePass, tolerance) {
  const reference = referencePass.normalizedHits.map((hit) => hit.quantizedPosition);
  const candidate = candidatePass.normalizedHits.map((hit) => hit.quantizedPosition);

  if (!reference.length || !candidate.length) {
    return 0;
  }

  let referenceIndex = 0;
  let candidateIndex = 0;
  let matched = 0;
  let distancePenalty = 0;

  while (referenceIndex < reference.length && candidateIndex < candidate.length) {
    const difference = candidate[candidateIndex] - reference[referenceIndex];
    if (Math.abs(difference) <= tolerance + EPSILON) {
      matched += 1;
      distancePenalty += Math.abs(difference) / Math.max(tolerance, EPSILON);
      referenceIndex += 1;
      candidateIndex += 1;
    } else if (difference < 0) {
      candidateIndex += 1;
    } else {
      referenceIndex += 1;
    }
  }

  const countScore = matched / Math.max(reference.length, candidate.length);
  const timingScore = matched ? 1 - distancePenalty / matched : 0;
  return round(clamp(countScore * 0.82 + timingScore * 0.18, 0, 1), 4);
}

function findReferencePass(analyzedPasses, tolerance) {
  let bestPass = analyzedPasses[0] || null;
  let bestScore = -1;

  for (const pass of analyzedPasses) {
    const score =
      analyzedPasses.reduce((sum, otherPass) => {
        if (otherPass === pass) {
          return sum + 1;
        }
        return sum + comparePasses(pass, otherPass, tolerance);
      }, 0) / analyzedPasses.length;

    if (score > bestScore) {
      bestScore = score;
      bestPass = pass;
    }
  }

  return bestPass;
}

function prepareAnalysisPasses(sourcePasses) {
  return (Array.isArray(sourcePasses) ? sourcePasses : [])
    .filter((pass) => Array.isArray(pass.hitsMs) && pass.hitsMs.length > 0)
    .slice(-APP_CONFIG.analysis.maxStoredPasses);
}

function hasEnoughPasses(analyzedPasses) {
  return analyzedPasses.length >= APP_CONFIG.analysis.minPassesForPattern;
}

function buildCollectingResult(meter, analyzedPasses) {
  return {
    meter: meter.id,
    status: "collecting",
    referencePass: null,
    passes: analyzedPasses,
    confidence: 0,
    message: analyzedPasses.length === 0 ? "Waiting for hits" : "Need another pass"
  };
}

function comparePassesToReference(analyzedPasses, referencePass, tolerance) {
  return analyzedPasses.map((pass) => {
    const similarity =
      pass === referencePass ? 1 : comparePasses(referencePass, pass, tolerance);
    return {
      ...pass,
      similarityToReference: round(similarity, 4),
      confidence: round(pass.confidence * (0.72 + similarity * 0.28), 4)
    };
  });
}

function buildAnalysisResult(meter, comparedPasses, referencePass) {
  const matchingPasses = comparedPasses.filter(
    (pass) => pass.similarityToReference >= APP_CONFIG.analysis.minConfidenceForPattern
  );
  const averageSimilarity =
    matchingPasses.reduce((sum, pass) => sum + pass.similarityToReference, 0) /
    Math.max(1, matchingPasses.length);
  const passCountBonus = Math.min(0.16, matchingPasses.length * 0.04);
  const confidence = round(averageSimilarity * (0.78 + passCountBonus), 4);
  const ready =
    matchingPasses.length >= APP_CONFIG.analysis.minPassesForPattern &&
    confidence >= APP_CONFIG.analysis.minConfidenceForPattern;
  const stableReference =
    comparedPasses.find((pass) => pass.index === referencePass.index) || referencePass;

  return {
    meter: meter.id,
    status: ready ? "ready" : "collecting",
    referencePass: ready ? stableReference : null,
    passes: comparedPasses,
    confidence: ready ? confidence : round(confidence * 0.7, 4),
    message: ready ? "Pattern ready" : "Collecting similar passes"
  };
}

function buildNormalizedHits(hitsMs, passDurationMs, meter) {
  const positions = hitsMs.map((rawMs) => positionFromHitMs(rawMs, passDurationMs, meter));
  const quantized = quantizeHitPositions(positions, meter);

  return dedupeQuantizedHits(
    hitsMs.map((rawMs, index) => ({
      rawMs: round(rawMs, 3),
      position: round(positions[index], 4),
      quantizedPosition: round(quantized[index], 4)
    }))
  );
}

function dedupeQuantizedHits(hits) {
  const deduped = [];

  for (const hit of hits) {
    const previous = deduped[deduped.length - 1];
    if (
      previous === undefined ||
      Math.abs(hit.quantizedPosition - previous.quantizedPosition) >= 0.0001
    ) {
      deduped.push(hit);
      continue;
    }

    if (
      Math.abs(hit.position - hit.quantizedPosition) <
      Math.abs(previous.position - previous.quantizedPosition)
    ) {
      deduped[deduped.length - 1] = hit;
    }
  }

  return deduped;
}

function calculatePassConfidence(normalizedHits, elements, tolerance) {
  const hitConfidence = normalizedHits.length
    ? normalizedHits.reduce((sum, hit) => {
        const distance = Math.abs(hit.position - hit.quantizedPosition);
        return sum + clamp(1 - distance / Math.max(tolerance, EPSILON), 0, 1);
      }, 0) / normalizedHits.length
    : 0;
  const elementConfidence = elements.length
    ? elements.reduce((sum, element) => sum + element.confidence, 0) / elements.length
    : 0;

  return round(hitConfidence * 0.65 + elementConfidence * 0.35, 4);
}

// Переименовывает длительности в долях с триольной сеткой: благодаря
// посеточной квантизации (quantizeHitPositions) доля либо целиком бинарная,
// либо целиком триольная, поэтому заполненность доли не требуется.
function spellTupletDurations(elements, meter) {
  if (meter.unitName !== "quarter" || !elements.length) {
    return elements;
  }

  const spelled = elements.map((element) => ({ ...element }));

  for (let beat = 0; beat < meter.unitsPerPass; beat += 1) {
    const beatStart = beat;
    const beatEnd = beat + 1;
    const beatElements = spelled.filter(
      (element) =>
        element.fromPosition >= beatStart - EPSILON &&
        element.fromPosition < beatEnd - EPSILON &&
        element.toPosition <= beatEnd + EPSILON
    );

    if (!beatElements.length || !usesTripletGrid(beatElements, beatStart)) {
      continue;
    }

    for (const element of beatElements) {
      const tripletDuration = getTripletDuration(element.value);
      if (tripletDuration) {
        element.duration = tripletDuration;
        element.confidence = Math.max(element.confidence, 0.96);
      }
    }
  }

  return spelled;
}

function usesTripletGrid(elements, beatStart) {
  return elements.some((element) =>
    [element.fromPosition, element.toPosition].some((position) =>
      isTripletOnlyPoint(position - beatStart)
    )
  );
}

function isTripletOnlyPoint(value) {
  const normalized = ((value % 1) + 1) % 1;
  return [1 / 6, 1 / 3, 2 / 3, 5 / 6].some(
    (tripletPoint) => Math.abs(normalized - tripletPoint) < 0.001
  );
}

function getTripletDuration(value) {
  const tripletDurations = [
    ["sixteenthTriplet", 1 / 6],
    ["eighthTriplet", 1 / 3],
    ["dottedEighthTriplet", 1 / 2],
    ["quarterTriplet", 2 / 3]
  ];

  const match = tripletDurations.find(([, durationValue]) => Math.abs(value - durationValue) < 0.001);
  return match?.[0] || null;
}

