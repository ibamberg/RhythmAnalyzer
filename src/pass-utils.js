import { APP_CONFIG } from "./config.js";

const EPSILON = 0.000001;

// Чуть ранний удар перед началом прохода считаем ударом в 0 мс.
function normalizeHitMs(hitMs, config = APP_CONFIG.input) {
  if (Math.abs(hitMs) <= config.earlyHitSnapMs) {
    return 0;
  }
  return hitMs;
}

function removeDuplicateHits(hitsMs, duplicateHitMs = APP_CONFIG.input.duplicateHitMs) {
  const deduped = [];

  for (const hit of hitsMs) {
    const previous = deduped[deduped.length - 1];
    if (previous === undefined || Math.abs(hit - previous) >= duplicateHitMs) {
      deduped.push(round(hit, 3));
    }
  }

  return deduped;
}

// Очищает удары одного прохода: привязка к 0, границы прохода, сортировка и дубли.
export function sanitizeHits(hitsMs, passDurationMs, config = APP_CONFIG.input) {
  const cleaned = hitsMs
    .filter((hit) => Number.isFinite(hit))
    .map((hit) => normalizeHitMs(hit, config))
    .filter((hit) => hit >= 0 && hit <= passDurationMs)
    .sort((a, b) => a - b);

  return removeDuplicateHits(cleaned, config.duplicateHitMs);
}

// Переводит миллисекунды внутри прохода в позицию в единицах размера.
export function positionFromHitMs(hitMs, passDurationMs, meter) {
  return (hitMs / passDurationMs) * meter.unitsPerPass;
}

export function hitMsFromPosition(position, passDurationMs, meter) {
  return (position / meter.unitsPerPass) * passDurationMs;
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

export function getPositionTolerance(passDurationMs, unitsPerPass, config = APP_CONFIG.analysis) {
  const timeTolerance = (config.hitToleranceMs / passDurationMs) * unitsPerPass;
  return clamp(
    Math.max(config.adaptiveToleranceRatio, timeTolerance),
    config.adaptiveToleranceRatio,
    0.28
  );
}

function buildQuantizationCandidates(meter) {
  const candidates = new Set([0, meter.unitsPerPass]);

  if (meter.unitName === "quarter") {
    for (let unit = 0; unit <= meter.unitsPerPass; unit += 1) {
      candidates.add(round(unit, 6));
      candidates.add(round(unit + 0.25, 6));
      candidates.add(round(unit + 0.5, 6));
      candidates.add(round(unit + 0.75, 6));
      candidates.add(round(unit + 1 / 6, 6));
      candidates.add(round(unit + 1 / 3, 6));
      candidates.add(round(unit + 2 / 3, 6));
      candidates.add(round(unit + 5 / 6, 6));
    }
  } else {
    for (let unit = 0; unit <= meter.unitsPerPass; unit += 0.5) {
      candidates.add(round(unit, 6));
    }
  }

  return [...candidates]
    .filter((candidate) => candidate >= 0 - EPSILON && candidate <= meter.unitsPerPass + EPSILON)
    .sort((a, b) => a - b);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
