import { APP_CONFIG } from "./config.js";
import { clamp, round } from "./utils.js";

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

const BINARY_STEPS = [0, 0.25, 0.5, 0.75, 1];
const TERNARY_STEPS = [0, 1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6, 1];
// Бинарная сетка — норма, триоль — помеченное исключение, поэтому триоль
// выбираем только если она вписывается ЗАМЕТНО лучше (на ~25%), а не на
// доли процента. Иначе плотный рандомный тап (~0.28 между ударами) случайно
// перевешивал в пользу триолей и рисовал скобки «3» на ровном месте.
const TERNARY_BIAS = 0.75;

// Квантизация с одной сеткой на каждую долю: бинарной или триольной,
// по меньшей суммарной ошибке (при равенстве — бинарная). Смешение сеток
// внутри доли порождало невозможные комбинации длительностей
// (например «три шестнадцатых + восьмая» в одной доле 4/4).
export function quantizeHitPositions(positions, meter) {
  if (meter.unitName !== "quarter") {
    return positions.map((position) =>
      clamp(Math.round(position * 2) / 2, 0, meter.unitsPerPass)
    );
  }

  const result = new Array(positions.length);
  const beatBuckets = new Map();

  positions.forEach((position, index) => {
    const beat = clamp(Math.floor(position + EPSILON), 0, meter.unitsPerPass - 1);
    if (!beatBuckets.has(beat)) {
      beatBuckets.set(beat, []);
    }
    beatBuckets.get(beat).push(index);
  });

  for (const [beat, indexes] of beatBuckets) {
    const binary = quantizeToSteps(positions, indexes, beat, BINARY_STEPS);
    const ternary = quantizeToSteps(positions, indexes, beat, TERNARY_STEPS);
    // Триоль — это деление доли на 3, поэтому триольную сетку выбираем,
    // только когда в доле реально звучит триольная фигура: минимум 3 удара
    // и якорь на основной триольной точке. Свинговую пару (2 удара) пишем
    // бинарно — пунктиром, а не одинокой скобкой «3» над двумя нотами.
    const isGenuineTriplet =
      indexes.length >= 3 && hasPrimaryTripletHit(positions, indexes, beat);
    const chosen =
      ternary.error < binary.error * TERNARY_BIAS && isGenuineTriplet ? ternary : binary;

    indexes.forEach((positionIndex, i) => {
      result[positionIndex] = chosen.values[i];
    });
  }

  return result;
}

const PRIMARY_TRIPLET_POINTS = [1 / 3, 2 / 3];
const PRIMARY_TRIPLET_TOLERANCE = 0.09;

// Триольная сетка содержит секстольные точки (1/6, 5/6), к которым легко
// «прилипает» одиночный неточный удар: 0.82 доли — это поздняя «и» (0.75),
// а не секстоль 5/6. Долю признаём триольной, только если хотя бы один удар
// лежит рядом с основной триольной точкой.
function hasPrimaryTripletHit(positions, indexes, beat) {
  return indexes.some((index) => {
    const local = positions[index] - beat;
    return PRIMARY_TRIPLET_POINTS.some(
      (point) => Math.abs(local - point) <= PRIMARY_TRIPLET_TOLERANCE
    );
  });
}

function quantizeToSteps(positions, indexes, beat, steps) {
  let error = 0;
  const values = indexes.map((index) => {
    const local = positions[index] - beat;
    let best = steps[0];
    let bestDistance = Math.abs(local - best);

    for (const step of steps) {
      const distance = Math.abs(local - step);
      if (distance < bestDistance) {
        best = step;
        bestDistance = distance;
      }
    }

    error += bestDistance;
    return round(beat + best, 6);
  });

  return { values, error };
}

export function getPositionTolerance(passDurationMs, unitsPerPass, config = APP_CONFIG.analysis) {
  const timeTolerance = (config.hitToleranceMs / passDurationMs) * unitsPerPass;
  return clamp(
    Math.max(config.adaptiveToleranceRatio, timeTolerance),
    config.adaptiveToleranceRatio,
    0.28
  );
}


