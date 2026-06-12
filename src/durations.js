import { APP_CONFIG } from "./config.js";
import { clamp } from "./utils.js";

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

// Сопоставляет расстояние между ударами с ближайшей длительностью.
// Значения выражены в единицах размера, не в миллисекундах.
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
    if (!Number.isFinite(durationValue)) {
      continue;
    }
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

