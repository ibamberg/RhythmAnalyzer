import { getMeterConfig } from "./config.js";

export function buildTimelineModel(analyzeResult, renderMode = "unicode") {
  const meter = getMeterConfig(analyzeResult.meter);
  const sourcePass =
    analyzeResult.referencePass || analyzeResult.passes[analyzeResult.passes.length - 1] || null;

  if (!sourcePass || sourcePass.elements.length === 0) {
    return {
      status: analyzeResult.passes.length ? "collecting" : "empty",
      segments: [],
      beatMarkers: buildBeatMarkers(meter),
      confidence: analyzeResult.confidence
    };
  }

  return {
    status: analyzeResult.status,
    segments: sourcePass.elements.map((element) => ({
      type: "note",
      duration: element.duration,
      value: element.value,
      widthPercent: round((element.value / meter.unitsPerPass) * 100, 4),
      label: formatDurationLabel(element.duration),
      glyph: getDurationGlyph(element.duration, renderMode),
      confidence: element.confidence
    })),
    beatMarkers: buildBeatMarkers(meter),
    confidence: analyzeResult.confidence
  };
}

export function getDurationGlyph(duration, renderMode = "unicode") {
  if (renderMode === "svg") {
    return "TODO";
  }

  const glyphs = {
    whole: "𝅝",
    dottedHalf: "𝅗𝅥.",
    half: "𝅗𝅥",
    dottedQuarter: "♩.",
    quarter: "♩",
    dottedEighth: "♪.",
    eighth: "♪",
    eighthTriplet: "♪3",
    sixteenth: "♬"
  };

  return glyphs[duration] || "♩";
}

function buildBeatMarkers(meter) {
  return Array.from({ length: meter.unitsPerPass }, (_, index) => ({
    positionPercent: round((index / meter.unitsPerPass) * 100, 4),
    label: String(index + 1),
    strong: meter.strongUnits.includes(index)
  }));
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
