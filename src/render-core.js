import { getBeatBoundaries, getMeterConfig } from "./meter.js";
import { clamp, round } from "./utils.js";

// Модель для таймлайна: только данные, без чтения или записи DOM.
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
      rhythmBoundaries: getBeatBoundaries(meter),
      confidence: analyzeResult.confidence
    };
  }

  return {
    status: analyzeResult.status,
    segments: buildTimelineSegments(sourcePass),
    beatMarkers: buildBeatMarkers(meter),
    meterUnits: meter.unitsPerPass,
    meterUnitName: meter.unitName,
    rhythmBoundaries: getBeatBoundaries(meter),
    confidence: analyzeResult.confidence
  };
}

function buildTimelineSegments(sourcePass) {
  return sourcePass.elements.map((element) => ({
    duration: element.duration,
    value: element.value,
    fromPosition: element.fromPosition,
    toPosition: element.toPosition
  }));
}

function buildBeatMarkers(meter) {
  return Array.from({ length: meter.unitsPerPass }, (_, index) => ({
    positionPercent: round((index / meter.unitsPerPass) * 100, 4),
    label: String(index + 1),
    strong: meter.strongUnits.includes(index)
  }));
}

// Возвращает HTML/SVG строку нотной дорожки; DOM здесь не трогаем.
export function renderSongsterrRhythm(segments, meterUnits, rhythmBoundaries, rhythmWidth) {
  const notes = buildRhythmNotes(segments, meterUnits, rhythmBoundaries, rhythmWidth);
  const stems = notes
    .filter((note) => note.stem)
    .map((note) => renderRhythmStem(note, rhythmWidth))
    .join("");
  const beams = renderRhythmBeams(notes, rhythmWidth);
  const tuplets = renderRhythmTuplets(notes, rhythmWidth);
  const holds = notes
    .filter((note) => note.duration === "whole")
    .map((note) => {
      const width = round(clamp(Math.max(34, note.endX - note.x), 1, rhythmWidth - note.x), 3);
      return `<rect class="rhythm-hold" x="${note.x}" y="83" width="${width}" height="4" />`;
    })
    .join("");

  return `
    <svg class="songsterr-rhythm" viewBox="0 0 ${rhythmWidth} 112" preserveAspectRatio="none" aria-hidden="true">
      ${holds}
      ${stems}
      ${beams}
      ${tuplets.paths}
    </svg>
    ${tuplets.labels}
  `;
}

// Элементы из rhythm-core всегда лежат внутри одной битовой группы
// (buildNoteElements режет окна по границам), поэтому сегменты не требуют
// разрезания — только перевод в экранные координаты.
function buildRhythmNotes(segments, meterUnits, rhythmBoundaries, rhythmWidth) {
  return segments.map((segment) => {
    const startX = positionToRhythmX(
      segment.fromPosition,
      meterUnits,
      rhythmBoundaries,
      "start",
      rhythmWidth
    );
    const endX = positionToRhythmX(
      segment.toPosition,
      meterUnits,
      rhythmBoundaries,
      "end",
      rhythmWidth
    );
    const info = getRhythmDurationInfo(segment.duration);

    return {
      ...segment,
      x: startX,
      startX,
      endX,
      beamGroup: getBeamGroup(segment.fromPosition, rhythmBoundaries),
      stem: info.stem !== false,
      stemTop: info.stemTop,
      stemBottom: info.stemBottom,
      beams: info.beams,
      dotted: info.dotted
    };
  });
}

function positionToRhythmX(position, meterUnits, rhythmBoundaries, edge = "start", width = 1000) {
  const boundaries = Array.isArray(rhythmBoundaries) && rhythmBoundaries.length
    ? rhythmBoundaries
    : [0, meterUnits];
  const boundaryIndex = findRhythmBoundaryIndex(position, boundaries, edge);
  const from = boundaries[boundaryIndex] ?? 0;
  const to = boundaries[boundaryIndex + 1] ?? meterUnits;
  const groupLeft = (from / meterUnits) * width;
  const groupRight = (to / meterUnits) * width;
  const groupWidth = Math.max(1, groupRight - groupLeft);
  const inset = Math.min(26, groupWidth * 0.11);
  const local = clamp((position - from) / Math.max(0.0001, to - from), 0, 1);

  return round(groupLeft + inset + local * Math.max(1, groupWidth - inset * 2), 3);
}

function findRhythmBoundaryIndex(position, boundaries, edge = "start") {
  const epsilon = 0.0001;

  if (edge === "end") {
    for (let index = 1; index < boundaries.length; index += 1) {
      if (Math.abs(position - boundaries[index]) < epsilon) {
        return Math.max(0, index - 1);
      }
    }
  }

  for (let index = boundaries.length - 2; index >= 0; index -= 1) {
    if (position >= boundaries[index] - epsilon) {
      return index;
    }
  }

  return 0;
}

function getRhythmDurationInfo(duration) {
  const durations = {
    whole: { stem: false, beams: 0, dotted: false, stemTop: 46, stemBottom: 86 },
    dottedHalf: { beams: 0, dotted: true, stemTop: 42, stemBottom: 86 },
    half: { beams: 0, dotted: false, stemTop: 42, stemBottom: 86 },
    dottedQuarter: { beams: 0, dotted: true, stemTop: 24, stemBottom: 86 },
    quarter: { beams: 0, dotted: false, stemTop: 24, stemBottom: 86 },
    dottedEighth: { beams: 1, dotted: true, stemTop: 24, stemBottom: 86 },
    eighth: { beams: 1, dotted: false, stemTop: 24, stemBottom: 86 },
    eighthTriplet: { beams: 1, dotted: false, stemTop: 24, stemBottom: 86 },
    dottedEighthTriplet: { beams: 1, dotted: true, stemTop: 24, stemBottom: 86 },
    sixteenthTriplet: { beams: 2, dotted: false, stemTop: 24, stemBottom: 86 },
    quarterTriplet: { beams: 0, dotted: false, stemTop: 24, stemBottom: 86 },
    sixteenth: { beams: 2, dotted: false, stemTop: 24, stemBottom: 86 }
  };

  return durations[duration] || durations.quarter;
}

function getBeamGroup(position, rhythmBoundaries) {
  const boundaries = Array.isArray(rhythmBoundaries) && rhythmBoundaries.length
    ? rhythmBoundaries
    : [0, 1];
  return findRhythmBoundaryIndex(position, boundaries);
}

function renderRhythmStem(note, rhythmWidth) {
  const x = round(clamp(note.x, 0, rhythmWidth), 3);
  const dot = note.dotted
    ? `<path class="rhythm-dot" d="M ${round(getRhythmDotX(note, rhythmWidth), 3)} ${round(note.stemBottom - 12, 3)} h 0.01" />`
    : "";

  return `
    <line class="rhythm-stem" x1="${x}" y1="${note.stemTop}" x2="${x}" y2="${note.stemBottom}" />
    ${dot}
  `;
}

function getRhythmDotX(note, rhythmWidth) {
  return clamp(note.x + 8, 0, rhythmWidth);
}

function renderRhythmBeams(notes, rhythmWidth) {
  const beams = [];

  for (const level of [1, 2]) {
    let index = 0;
    while (index < notes.length) {
      if (notes[index].beams < level) {
        index += 1;
        continue;
      }

      const startIndex = index;
      while (
        index < notes.length &&
        notes[index].beams >= level &&
        notes[index].beamGroup === notes[startIndex].beamGroup
      ) {
        index += 1;
      }

      beams.push(...renderBeamRun(notes, startIndex, index, level, rhythmWidth));
    }
  }

  return beams.join("");
}

function renderBeamRun(notes, startIndex, endIndex, level, rhythmWidth) {
  const run = notes.slice(startIndex, endIndex);
  const y = level === 1 ? 83 : 75;
  const height = level === 1 ? 5 : 4;

  if (run.length === 1) {
    return [renderBeamStub(notes, startIndex, level, y, height, rhythmWidth)];
  }

  const first = run[0];
  const last = run[run.length - 1];
  return [renderBeamRect(first.x, last.x, y, height, rhythmWidth)];
}

function renderBeamStub(notes, noteIndex, level, y, height, rhythmWidth) {
  const note = notes[noteIndex];
  const direction = getBeamStubDirection(notes, noteIndex, level);
  const length = getRhythmBeamStubLength(notes, noteIndex, direction);

  return renderBeamRect(note.x, note.x + direction * length, y, height, rhythmWidth);
}

function getBeamStubDirection(notes, noteIndex, level) {
  const note = notes[noteIndex];
  const previous = notes[noteIndex - 1];
  const next = notes[noteIndex + 1];
  const lowerLevel = Math.max(1, level - 1);
  const hasPreviousBeam =
    previous && previous.beamGroup === note.beamGroup && previous.beams >= lowerLevel;
  const hasNextBeam =
    next && next.beamGroup === note.beamGroup && next.beams >= lowerLevel;

  return hasNextBeam || !hasPreviousBeam ? 1 : -1;
}

function getRhythmBeamStubLength(notes, noteIndex, direction) {
  const note = notes[noteIndex];
  const neighbor = direction > 0 ? notes[noteIndex + 1] : notes[noteIndex - 1];
  const available =
    neighbor && neighbor.beamGroup === note.beamGroup
      ? Math.abs(neighbor.x - note.x)
      : Math.abs(note.endX - note.startX);

  return clamp(available * 0.42, 18, 34);
}

function renderBeamRect(fromX, toX, y, height, rhythmWidth) {
  const stemWidth = 1.5;
  const left = Math.min(fromX, toX);
  const right = Math.max(fromX, toX);
  const x = clamp(left - stemWidth / 2, 0, rhythmWidth);
  const rightEdge = clamp(right + stemWidth / 2, 0, rhythmWidth);

  return `<rect class="rhythm-beam" x="${round(x, 3)}" y="${y}" width="${round(Math.max(1, rightEdge - x), 3)}" height="${height}" />`;
}

function renderRhythmTuplets(notes, rhythmWidth) {
  const paths = [];
  const labels = [];
  let index = 0;

  while (index < notes.length) {
    if (!isTripletDuration(notes[index].duration)) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (
      index < notes.length &&
      isTripletDuration(notes[index].duration) &&
      notes[index].beamGroup === notes[runStart].beamGroup
    ) {
      index += 1;
    }

    for (let groupStart = runStart; groupStart < index; groupStart += 1) {
      let groupEnd = groupStart;
      let totalValue = 0;
      while (groupEnd < index && totalValue < 1 - 0.001) {
        totalValue += notes[groupEnd].value;
        groupEnd += 1;
      }

      if (Math.abs(totalValue - 1) > 0.001 || groupEnd - groupStart < 2) {
        groupStart = groupEnd - 1;
        continue;
      }

      const first = notes[groupStart];
      const last = notes[groupEnd - 1];
      const left = round(clamp(first.x, 0, rhythmWidth), 3);
      const right = round(clamp(last.x, 0, rhythmWidth), 3);
      const center = round((left + right) / 2, 3);

      paths.push(`
        <path class="rhythm-tuplet" d="M ${left} 96 V 103 H ${right} V 96" />
      `);
      labels.push(
        `<span class="rhythm-tuplet-number" style="left:${round((center / rhythmWidth) * 100, 4)}%">3</span>`
      );

      groupStart = groupEnd - 1;
    }
  }

  return {
    paths: paths.join(""),
    labels: labels.join("")
  };
}

function isTripletDuration(duration) {
  return String(duration).includes("Triplet");
}

