import { getMeterConfig } from "./config.js";

export function buildTimelineModel(analyzeResult) {
  const meter = getMeterConfig(analyzeResult.meter);
  const sourcePass =
    analyzeResult.referencePass || analyzeResult.passes[analyzeResult.passes.length - 1] || null;

  if (!sourcePass || sourcePass.elements.length === 0) {
    return {
      status: analyzeResult.passes.length ? "collecting" : "empty",
      segments: [],
      beatMarkers: buildBeatMarkers(meter),
      meterUnits: meter.unitsPerPass,
      meterUnitName: meter.unitName,
      rhythmBoundaries: buildRhythmBoundaries(meter),
      confidence: analyzeResult.confidence
    };
  }

  return {
    status: analyzeResult.status,
    segments: sourcePass.elements.map((element) => ({
      type: "note",
      duration: element.duration,
      value: element.value,
      fromPosition: element.fromPosition,
      toPosition: element.toPosition,
      widthPercent: round((element.value / meter.unitsPerPass) * 100, 4),
      label: formatDurationLabel(element.duration),
      confidence: element.confidence
    })),
    beatMarkers: buildBeatMarkers(meter),
    meterUnits: meter.unitsPerPass,
    meterUnitName: meter.unitName,
    rhythmBoundaries: buildRhythmBoundaries(meter),
    confidence: analyzeResult.confidence
  };
}

function buildBeatMarkers(meter) {
  return Array.from({ length: meter.unitsPerPass }, (_, index) => ({
    positionPercent: round((index / meter.unitsPerPass) * 100, 4),
    label: String(index + 1),
    strong: meter.strongUnits.includes(index)
  }));
}

function buildRhythmBoundaries(meter) {
  const boundaries = [0];
  let cursor = 0;

  for (const groupSize of meter.defaultGrouping) {
    cursor += groupSize;
    boundaries.push(cursor);
  }

  if (boundaries.at(-1) !== meter.unitsPerPass) {
    boundaries.push(meter.unitsPerPass);
  }

  return boundaries;
}

function formatDurationLabel(duration) {
  return duration
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
