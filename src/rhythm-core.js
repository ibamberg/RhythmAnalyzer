import { APP_CONFIG, getMeterConfig } from "./config.js";

const EPSILON = 0.000001;

const DURATION_VALUES = {
  quarter: {
    whole: 4,
    dottedHalf: 3,
    half: 2,
    dottedQuarter: 1.5,
    quarter: 1,
    dottedEighth: 0.75,
    eighth: 0.5,
    eighthTriplet: 1 / 3,
    sixteenth: 0.25
  },
  eighth: {
    whole: 8,
    dottedHalf: 6,
    half: 4,
    dottedQuarter: 3,
    quarter: 2,
    dottedEighth: 1.5,
    eighth: 1,
    eighthTriplet: 2 / 3,
    sixteenth: 0.5
  }
};

const DURATION_ORDER = [
  "whole",
  "dottedHalf",
  "half",
  "dottedQuarter",
  "quarter",
  "dottedEighth",
  "eighth",
  "eighthTriplet",
  "sixteenth"
];

export function analyzeRhythm(input) {
  const meter = getMeterConfig(input.meter);
  const sourcePasses = Array.isArray(input.passes) ? input.passes : [];
  const nonEmptyPasses = sourcePasses
    .filter((pass) => Array.isArray(pass.hitsMs) && pass.hitsMs.length > 0)
    .slice(-APP_CONFIG.analysis.maxStoredPasses);

  const analyzedPasses = nonEmptyPasses.map((pass) => analyzePass(meter, pass));

  if (analyzedPasses.length < APP_CONFIG.analysis.minPassesForPattern) {
    return {
      meter: meter.id,
      status: "collecting",
      referencePass: null,
      passes: analyzedPasses,
      confidence: 0,
      message: analyzedPasses.length === 0 ? "Waiting for hits" : "Need another pass"
    };
  }

  const adaptiveTolerance = calculateAdaptiveTolerance(analyzedPasses, APP_CONFIG.analysis);
  const referenceIndex = findReferencePassIndex(analyzedPasses, adaptiveTolerance);
  const referencePass = analyzedPasses[referenceIndex];

  const passesWithSimilarity = analyzedPasses.map((pass) => {
    const similarity =
      pass === referencePass ? 1 : comparePasses(referencePass, pass, adaptiveTolerance);
    return {
      ...pass,
      similarityToReference: round(similarity, 4),
      confidence: round(pass.confidence * (0.72 + similarity * 0.28), 4)
    };
  });

  const matchingPasses = passesWithSimilarity.filter(
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
    passesWithSimilarity.find((pass) => pass.index === referencePass.index) || referencePass;

  return {
    meter: meter.id,
    status: ready ? "ready" : "collecting",
    referencePass: ready ? stableReference : null,
    passes: passesWithSimilarity,
    confidence: ready ? confidence : round(confidence * 0.7, 4),
    message: ready ? "Pattern ready" : "Collecting similar passes"
  };
}

export function analyzePass(meter, pass) {
  const hitsMs = sanitizeHits(pass.hitsMs, pass.durationMs);
  const tolerance = getPositionTolerance(pass.durationMs, meter.unitsPerPass);
  const normalizedHits = hitsMs.map((rawMs) => {
    const position = (rawMs / pass.durationMs) * meter.unitsPerPass;
    const quantizedPosition = quantizePosition(position, meter);
    return {
      rawMs: round(rawMs, 3),
      position: round(position, 4),
      quantizedPosition: round(quantizedPosition, 4)
    };
  });

  const elements = normalizedHits.map((hit, index) => {
    const nextHit = normalizedHits[index + 1];
    const toPosition = nextHit ? nextHit.quantizedPosition : meter.unitsPerPass;
    const value = Math.max(0, toPosition - hit.quantizedPosition);
    const durationInfo = classifyDuration(value, meter, tolerance);
    const fromMs = (hit.quantizedPosition / meter.unitsPerPass) * pass.durationMs;
    const toMs = (toPosition / meter.unitsPerPass) * pass.durationMs;

    return {
      type: "note",
      duration: durationInfo.duration,
      value: round(value, 4),
      fromPosition: round(hit.quantizedPosition, 4),
      toPosition: round(toPosition, 4),
      fromMs: round(fromMs, 3),
      toMs: round(toMs, 3),
      confidence: round(durationInfo.confidence, 4)
    };
  });

  const hitConfidence = normalizedHits.length
    ? normalizedHits.reduce((sum, hit) => {
        const distance = Math.abs(hit.position - hit.quantizedPosition);
        return sum + clamp(1 - distance / Math.max(tolerance, EPSILON), 0, 1);
      }, 0) / normalizedHits.length
    : 0;
  const elementConfidence = elements.length
    ? elements.reduce((sum, element) => sum + element.confidence, 0) / elements.length
    : 0;

  return {
    index: pass.index,
    durationMs: pass.durationMs,
    hitsMs,
    normalizedHits,
    elements,
    confidence: round(hitConfidence * 0.65 + elementConfidence * 0.35, 4),
    similarityToReference: null
  };
}

export function sanitizeHits(hitsMs, durationMs) {
  const cleaned = hitsMs
    .filter((hit) => Number.isFinite(hit))
    .map((hit) => {
      if (Math.abs(hit) <= APP_CONFIG.input.earlyHitSnapMs) {
        return 0;
      }
      return hit;
    })
    .filter((hit) => hit >= 0 && hit <= durationMs)
    .sort((a, b) => a - b);

  const deduped = [];
  for (const hit of cleaned) {
    const previous = deduped[deduped.length - 1];
    if (previous === undefined || Math.abs(hit - previous) >= APP_CONFIG.input.duplicateHitMs) {
      deduped.push(round(hit, 3));
    }
  }
  return deduped;
}

export function quantizePosition(position, meter) {
  const candidates = buildQuantizationCandidates(meter);
  let nearest = candidates[0];
  let nearestDistance = Math.abs(position - nearest);

  for (const candidate of candidates) {
    const distance = Math.abs(position - candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function classifyDuration(value, meter, tolerance = APP_CONFIG.analysis.adaptiveToleranceRatio) {
  const values = DURATION_VALUES[meter.unitName];
  let bestDuration = "quarter";
  let bestValue = values.quarter;
  let bestDistance = Infinity;

  for (const duration of DURATION_ORDER) {
    if (duration === "eighthTriplet" && meter.unitName === "eighth") {
      continue;
    }
    const durationValue = values[duration];
    const distance = Math.abs(value - durationValue);
    if (distance < bestDistance) {
      bestDuration = duration;
      bestValue = durationValue;
      bestDistance = distance;
    }
  }

  const allowedDistance = Math.max(tolerance * 1.4, bestValue * 0.09);
  return {
    duration: bestDuration,
    value: bestValue,
    confidence: clamp(1 - bestDistance / Math.max(allowedDistance, EPSILON), 0, 1)
  };
}

export function calculateAdaptiveTolerance(passes, baseConfig = APP_CONFIG.analysis) {
  if (!passes.length) {
    return baseConfig.adaptiveToleranceRatio;
  }

  const meterUnits = Math.max(...passes.map((pass) => pass.normalizedHits.at(-1)?.position || 1));
  const averageDuration =
    passes.reduce((sum, pass) => sum + pass.durationMs, 0) / Math.max(1, passes.length);
  const timeToleranceAsPosition =
    (baseConfig.hitToleranceMs / Math.max(1, averageDuration)) * Math.max(1, meterUnits);

  return clamp(
    Math.max(baseConfig.adaptiveToleranceRatio, timeToleranceAsPosition),
    baseConfig.adaptiveToleranceRatio,
    0.28
  );
}

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

function findReferencePassIndex(analyzedPasses, tolerance) {
  let bestIndex = 0;
  let bestScore = -1;

  for (let index = 0; index < analyzedPasses.length; index += 1) {
    const pass = analyzedPasses[index];
    const score =
      analyzedPasses.reduce((sum, otherPass) => {
        if (otherPass === pass) {
          return sum + 1;
        }
        return sum + comparePasses(pass, otherPass, tolerance);
      }, 0) / analyzedPasses.length;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function buildQuantizationCandidates(meter) {
  const candidates = new Set([0, meter.unitsPerPass]);

  if (meter.unitName === "quarter") {
    for (let unit = 0; unit <= meter.unitsPerPass; unit += 1) {
      candidates.add(round(unit, 6));
      candidates.add(round(unit + 0.25, 6));
      candidates.add(round(unit + 0.5, 6));
      candidates.add(round(unit + 0.75, 6));
      candidates.add(round(unit + 1 / 3, 6));
      candidates.add(round(unit + 2 / 3, 6));
    }
  } else {
    for (let unit = 0; unit <= meter.unitsPerPass; unit += 0.5) {
      candidates.add(round(unit, 6));
    }
  }

  return [...candidates]
    .filter((position) => position >= 0 && position <= meter.unitsPerPass)
    .sort((a, b) => a - b);
}

function getPositionTolerance(durationMs, unitsPerPass) {
  const timeTolerance = (APP_CONFIG.analysis.hitToleranceMs / durationMs) * unitsPerPass;
  return clamp(
    Math.max(APP_CONFIG.analysis.adaptiveToleranceRatio, timeTolerance),
    APP_CONFIG.analysis.adaptiveToleranceRatio,
    0.28
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
