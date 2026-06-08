import { APP_CONFIG, getMeterConfig, getPassDurationMs } from "./config.js";
import { analyzeRhythm } from "./rhythm-core.js?v=3";
import { buildTimelineModel } from "./render-core.js?v=2";
import { Metronome } from "./metronome.js?v=2";
import { MicrophoneOnsetDetector } from "./audio-input.js";
import { bindTapInput } from "./tap-input.js";
import { renderDebugPanel } from "./debug-panel.js";

const dom = {
  meterSelect: document.querySelector("#meterSelect"),
  bpmInput: document.querySelector("#bpmInput"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  soundToggle: document.querySelector("#soundToggle"),
  clickModeInputs: [...document.querySelectorAll('input[name="clickMode"]')],
  startButton: document.querySelector("#startButton"),
  resetButton: document.querySelector("#resetButton"),
  debugToggle: document.querySelector("#debugToggle"),
  tapPad: document.querySelector("#tapPad"),
  padLabel: document.querySelector("#padLabel"),
  statusLabel: document.querySelector("#statusLabel"),
  messageLabel: document.querySelector("#messageLabel"),
  confidenceLabel: document.querySelector("#confidenceLabel"),
  beatMarkers: document.querySelector("#beatMarkers"),
  timelineSegments: document.querySelector("#timelineSegments"),
  playhead: document.querySelector("#playhead"),
  debugPanel: document.querySelector("#debugPanel"),
  testHitMode: document.querySelector("#testHitMode"),
  testHitsInput: document.querySelector("#testHitsInput"),
  testApplyButton: document.querySelector("#testApplyButton"),
  testClearButton: document.querySelector("#testClearButton")
};

const state = {
  passMap: new Map(),
  currentPassIndex: null,
  analysisResult: analyzeRhythm({ meter: "4/4", passes: [] }),
  isDebugVisible: true,
  inputSource: "tap",
  micDebug: null,
  micAlignmentOffsetMs: null,
  debugEvents: [],
  rafId: null
};

const metronome = new Metronome({
  onPassStart: (pass) => {
    state.currentPassIndex = pass.index;
    ensurePass(pass.index, pass.startedAtMs, pass.durationMs);
    prunePasses();
    refreshAnalysis();
  }
});

const micDetector = new MicrophoneOnsetDetector({
  onOnset: (event) => {
    if (state.inputSource === "mic") {
      handleMicOnset(event);
    }
  },
  onLevel: (frame) => {
    if (state.inputSource !== "mic") {
      return;
    }
    state.micDebug = frame;
  }
});

bindTapInput({
  element: dom.tapPad,
  onTap: (timeMs) => {
    if (state.inputSource === "tap") {
      recordHit(timeMs);
    }
  },
  onVisualHit: flashPad
});

dom.startButton.addEventListener("click", () => {
  if (metronome.isRunning) {
    stop();
  } else {
    start();
  }
});

dom.resetButton.addEventListener("click", () => {
  resetData();
  render();
});

dom.testApplyButton.addEventListener("click", () => {
  applyTestHits();
});

dom.testClearButton.addEventListener("click", () => {
  dom.testHitsInput.value = "";
  resetData();
  render();
});

dom.testHitsInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyTestHits();
  }
});

dom.debugToggle.addEventListener("click", () => {
  state.isDebugVisible = !state.isDebugVisible;
  dom.debugToggle.classList.toggle("is-active", state.isDebugVisible);
  dom.debugPanel.classList.toggle("is-hidden", !state.isDebugVisible);
});

window.addEventListener("resize", () => {
  renderTimeline(buildTimelineModel(state.analysisResult));
});

for (const control of [dom.meterSelect, dom.bpmInput]) {
  control.addEventListener("change", () => {
    if (!metronome.isRunning) {
      resetData();
      render();
    }
  });
}

dom.soundToggle.addEventListener("change", () => {
  updateMetronomeSoundState();
  if (metronome.isRunning) {
    restart();
  }
});

dom.sensitivityInput.addEventListener("input", () => {
  micDetector.setSensitivity(dom.sensitivityInput.value);
  updateSensitivityFill();
});

dom.clickModeInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (metronome.isRunning) {
      restart();
    }
  });
});

document.querySelectorAll('input[name="inputSource"]').forEach((input) => {
  input.addEventListener("change", async () => {
    state.inputSource = getRadioValue("inputSource");
    updatePadMode();
    if (metronome.isRunning) {
      await syncInputSource();
      render();
    }
  });
});

render();
updatePadMode();
updateSensitivityFill();
updateMetronomeSoundState();
dom.debugToggle.classList.add("is-active");

async function start() {
  resetData();
  addDebugEvent("start requested");
  await metronome.ensureAudioReady();
  addDebugEvent(`metronome audio ${metronome.getAudioState()}`);
  await syncInputSource();
  await metronome.start(getSettings());
  addDebugEvent(`metronome clock started, sound ${dom.soundToggle.checked ? "on" : "off"}`);
  dom.startButton.textContent = "Stop";
  dom.startButton.classList.add("is-running");
  startPlayhead();
  render();
}

function stop() {
  metronome.stop();
  micDetector.stop();
  addDebugEvent("stopped");
  dom.startButton.textContent = "Start";
  dom.startButton.classList.remove("is-running");
  stopPlayhead();
  render();
}

async function restart() {
  stop();
  await start();
}

async function syncInputSource() {
  if (state.inputSource === "mic") {
    try {
      await micDetector.start();
      addDebugEvent("microphone ready");
    } catch (error) {
      state.inputSource = "tap";
      setRadioValue("inputSource", "tap");
      updatePadMode();
      dom.messageLabel.textContent = "Microphone unavailable";
      addDebugEvent("microphone unavailable");
      console.warn(error);
    }
  } else {
    micDetector.stop();
  }
}

function handleMicOnset(event) {
  const leak = getMetronomeLeak(event);
  if (leak.isLeak) {
    addDebugEvent(
      `mic onset ${formatDebugMs(event.timeMs)} ignored: near metronome click ${formatDebugMs(leak.clickTimeMs)}, delta ${formatDebugMs(leak.deltaMs)}ms`
    );
    render();
    return;
  }

  const alignedTimeMs = getAlignedMicTime(event.timeMs);
  const result = recordHit(alignedTimeMs, "mic", {
    rawTimeMs: event.timeMs,
    micAlignmentOffsetMs: state.micAlignmentOffsetMs
  });
  if (result.recorded) {
    flashPad();
  }
}

function recordHit(hitPerfMs, source = state.inputSource, options = {}) {
  if (!metronome.isRunning) {
    return { recorded: false, reason: "not-running" };
  }

  const info = metronome.getCurrentPassInfo(hitPerfMs);
  if (!info) {
    return { recorded: false, reason: "no-pass-info" };
  }

  let targetIndex = info.passIndex;
  let targetStartedAtMs = info.startedAtMs;
  let relativeMs = hitPerfMs - targetStartedAtMs;
  const earlyMs = APP_CONFIG.input.earlyHitSnapMs;
  const startSnapMs = APP_CONFIG.input.startHitSnapMs ?? earlyMs;

  if (relativeMs < 0) {
    if (Math.abs(relativeMs) > earlyMs) {
      return { recorded: false, reason: "too-early" };
    }
    relativeMs = 0;
  } else if (relativeMs <= startSnapMs) {
    relativeMs = 0;
  } else if (info.durationMs - relativeMs <= earlyMs) {
    targetIndex += 1;
    targetStartedAtMs += info.durationMs;
    relativeMs = 0;
  }

  const pass = ensurePass(targetIndex, targetStartedAtMs, info.durationMs);
  if (pass.hitsMs.some((hit) => Math.abs(hit - relativeMs) < APP_CONFIG.input.duplicateHitMs)) {
    return { recorded: false, reason: "duplicate", passIndex: targetIndex, hitMs: relativeMs };
  }

  pass.hitsMs.push(round(relativeMs, 3));
  pass.hitsMs.sort((a, b) => a - b);
  addDebugEvent(formatRecordedHitEvent(source, options.rawTimeMs, hitPerfMs, targetIndex, relativeMs, options.micAlignmentOffsetMs));
  refreshAnalysis();
  return { recorded: true, passIndex: targetIndex, hitMs: relativeMs };
}

function ensurePass(index, startedAtMs, durationMs) {
  if (!state.passMap.has(index)) {
    state.passMap.set(index, {
      index,
      startedAtMs,
      durationMs,
      hitsMs: []
    });
  }

  const pass = state.passMap.get(index);
  pass.startedAtMs = startedAtMs;
  pass.durationMs = durationMs;
  return pass;
}

function prunePasses() {
  const maxPasses = APP_CONFIG.analysis.maxStoredPasses;
  const sortedIndexes = [...state.passMap.keys()].sort((a, b) => a - b);
  while (sortedIndexes.length > maxPasses) {
    const index = sortedIndexes.shift();
    state.passMap.delete(index);
  }
}

function refreshAnalysis() {
  const meter = dom.meterSelect.value;
  const passes = getPasses().filter((pass) => pass.hitsMs.length > 0);
  state.analysisResult = analyzeRhythm({ meter, passes });
  render();
}

function applyTestHits() {
  const meter = getMeterConfig(dom.meterSelect.value);
  const durationMs = getPassDurationMs(meter, Number(dom.bpmInput.value) || 96);
  const mode = dom.testHitMode.value;
  const parsed = parseTestHits(dom.testHitsInput.value);

  if (!parsed.ok) {
    dom.messageLabel.textContent = parsed.message;
    addDebugEvent(parsed.message);
    renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult, getRuntimeDebug());
    return;
  }

  const hitsMs = mode === "ms"
    ? parsed.values
    : parsed.values.map((position) => (position / meter.unitsPerPass) * durationMs);
  const sanitizedHits = hitsMs
    .filter((hit) => Number.isFinite(hit) && hit >= 0 && hit < durationMs)
    .map((hit) => round(hit, 3))
    .sort((a, b) => a - b);

  if (!sanitizedHits.length) {
    dom.messageLabel.textContent = "No valid test hits";
    addDebugEvent("test hits rejected: empty");
    renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult, getRuntimeDebug());
    return;
  }

  if (metronome.isRunning) {
    stop();
  } else {
    stopPlayhead();
  }

  state.passMap.clear();
  state.currentPassIndex = 2;
  state.micAlignmentOffsetMs = null;
  state.debugEvents = [];

  for (const index of [1, 2]) {
    state.passMap.set(index, {
      index,
      startedAtMs: index * durationMs,
      durationMs,
      hitsMs: [...sanitizedHits]
    });
  }

  state.analysisResult = analyzeRhythm({
    meter: meter.id,
    passes: getPasses()
  });
  dom.playhead.style.left = "0%";
  addDebugEvent(`test hits applied: ${sanitizedHits.join(", ")}`);
  render();
}

function parseTestHits(rawValue) {
  const source = rawValue.trim();

  if (!source) {
    return { ok: false, message: "Paste a hit array" };
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch {
    value = source
      .replace(/[\[\]]/g, "")
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number);
  }

  if (!Array.isArray(value)) {
    return { ok: false, message: "Hits must be an array" };
  }

  const values = value.map(Number);
  if (!values.length || values.some((item) => !Number.isFinite(item))) {
    return { ok: false, message: "Hits must be numbers" };
  }

  return { ok: true, values };
}

function render() {
  const timelineModel = buildTimelineModel(state.analysisResult);
  renderTimeline(timelineModel);
  renderStatus(timelineModel);
  renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult, getRuntimeDebug());
}

function renderTimeline(model) {
  const rhythmWidth = getRhythmRenderWidth();

  dom.beatMarkers.innerHTML = model.beatMarkers
    .map(
      (marker) => `
        <div class="beat-marker ${marker.strong ? "is-strong" : ""}" style="left:${marker.positionPercent}%">
        </div>
      `
    )
    .join("");

  dom.timelineSegments.innerHTML = model.segments.length
    ? renderSongsterrRhythm(
        model.segments,
        model.meterUnits,
        model.meterUnitName,
        model.rhythmBoundaries,
        rhythmWidth
      )
    : "";
}

function getRhythmRenderWidth() {
  const width = Math.round(dom.timelineSegments.clientWidth);
  if (window.matchMedia("(max-width: 760px)").matches && width > 0) {
    return Math.max(320, width);
  }

  return 1000;
}

function renderSongsterrRhythm(segments, meterUnits, meterUnitName, rhythmBoundaries, rhythmWidth) {
  const notes = buildRhythmNotes(segments, meterUnits, meterUnitName, rhythmBoundaries, rhythmWidth);
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

function buildRhythmNotes(segments, meterUnits, meterUnitName, rhythmBoundaries, rhythmWidth) {
  const displaySegments = buildDisplayRhythmSegments(
    segments,
    meterUnits,
    meterUnitName,
    rhythmBoundaries
  );

  return displaySegments.map((segment) => {
    const startPercent = (segment.fromPosition / meterUnits) * 100;
    const endPercent = (segment.toPosition / meterUnits) * 100;
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
      startPercent,
      beamGroup: getBeamGroup(segment.fromPosition, rhythmBoundaries),
      stem: info.stem !== false,
      stemTop: info.stemTop,
      stemBottom: info.stemBottom,
      beams: info.beams,
      dotted: info.dotted
    };
  });
}

function buildDisplayRhythmSegments(segments, meterUnits, meterUnitName, rhythmBoundaries) {
  const boundaries = Array.isArray(rhythmBoundaries) && rhythmBoundaries.length
    ? rhythmBoundaries
    : [0, meterUnits];
  let fallbackPosition = 0;

  return segments.flatMap((segment, sourceIndex) => {
    const sourceFrom = Number.isFinite(segment.fromPosition)
      ? segment.fromPosition
      : fallbackPosition;
    const sourceTo = Number.isFinite(segment.toPosition)
      ? segment.toPosition
      : sourceFrom + segment.value;
    const pieces = [];
    let fromPosition = sourceFrom;

    fallbackPosition = sourceTo;

    if (isOnRhythmBoundary(sourceFrom, boundaries) && sourceTo <= meterUnits + 0.0001) {
      return [
        {
          ...segment,
          sourceIndex,
          duration: segment.duration || getDisplayDuration(sourceTo - sourceFrom, meterUnitName),
          value: Math.max(0, sourceTo - sourceFrom),
          fromPosition: sourceFrom,
          toPosition: sourceTo,
          isContinuation: false,
          continuesToNext: false
        }
      ];
    }

    while (fromPosition < sourceTo - 0.0001) {
      const boundary = getNextRhythmBoundary(fromPosition, boundaries, meterUnits);
      const toPosition = Math.min(sourceTo, boundary);
      const value = Math.max(0, toPosition - fromPosition);

      if (value > 0.0001) {
        pieces.push({
          ...segment,
          sourceIndex,
          duration: isOriginalPiece(fromPosition, toPosition, sourceFrom, sourceTo) && segment.duration
            ? segment.duration
            : getDisplayDuration(value, meterUnitName),
          value,
          fromPosition,
          toPosition,
          isContinuation: fromPosition > sourceFrom + 0.0001,
          continuesToNext: toPosition < sourceTo - 0.0001
        });
      }

      fromPosition = toPosition;
    }

    return pieces;
  });
}

function getNextRhythmBoundary(position, boundaries, meterUnits) {
  const epsilon = 0.0001;
  const nextBoundary = boundaries.find((boundary) => boundary > position + epsilon);
  return nextBoundary ?? meterUnits;
}

function isOnRhythmBoundary(position, boundaries) {
  const epsilon = 0.0001;
  return boundaries.some((boundary) => Math.abs(boundary - position) < epsilon);
}

function isOriginalPiece(fromPosition, toPosition, sourceFrom, sourceTo) {
  return (
    Math.abs(fromPosition - sourceFrom) < 0.0001 &&
    Math.abs(toPosition - sourceTo) < 0.0001
  );
}

function getDisplayDuration(value, meterUnitName) {
  const values = meterUnitName === "eighth"
    ? [
        ["whole", 8],
        ["dottedHalf", 6],
        ["half", 4],
        ["dottedQuarter", 3],
        ["quarter", 2],
        ["dottedEighth", 1.5],
        ["eighth", 1],
        ["sixteenth", 0.5]
      ]
    : [
        ["whole", 4],
        ["dottedHalf", 3],
        ["half", 2],
        ["dottedQuarter", 1.5],
        ["quarter", 1],
        ["dottedEighth", 0.75],
        ["eighth", 0.5],
        ["eighthTriplet", 1 / 3],
        ["sixteenth", 0.25]
      ];
  let best = values[0];
  let bestDistance = Infinity;

  for (const candidate of values) {
    const distance = Math.abs(value - candidate[1]);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best[0];
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

function renderStatus(model) {
  dom.statusLabel.textContent = model.status;
  dom.confidenceLabel.textContent = `${Math.round(model.confidence * 100)}%`;
  dom.messageLabel.textContent = state.analysisResult.message;
}

function resetData() {
  state.passMap.clear();
  state.currentPassIndex = null;
  state.micAlignmentOffsetMs = null;
  state.debugEvents = [];
  state.analysisResult = analyzeRhythm({ meter: dom.meterSelect.value, passes: [] });
  dom.playhead.style.left = "0%";
}

function startPlayhead() {
  stopPlayhead();
  const frame = () => {
    const info = metronome.getCurrentPassInfo();
    if (info) {
      dom.playhead.style.left = `${info.progress * 100}%`;
    }
    state.rafId = requestAnimationFrame(frame);
  };
  state.rafId = requestAnimationFrame(frame);
}

function stopPlayhead() {
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

function updatePadMode() {
  state.inputSource = getRadioValue("inputSource");
  dom.tapPad.classList.toggle("is-listening", state.inputSource === "mic");
  dom.padLabel.textContent = state.inputSource === "mic" ? "Mic" : "Tap";
}

function updateSensitivityFill() {
  const min = Number(dom.sensitivityInput.min);
  const max = Number(dom.sensitivityInput.max);
  const value = Number(dom.sensitivityInput.value);
  const percent = clamp(((value - min) / (max - min)) * 100, 0, 100);
  dom.sensitivityInput.style.background =
    `linear-gradient(to right, #58d6b2 0%, #58d6b2 ${percent}%, #31393c ${percent}%, #31393c 100%) center / 100% 4px no-repeat`;
}

function updateMetronomeSoundState() {
  const isSoundEnabled = dom.soundToggle.checked;
  for (const input of dom.clickModeInputs) {
    input.disabled = !isSoundEnabled;
  }
}

function flashPad() {
  dom.tapPad.classList.remove("is-hit");
  void dom.tapPad.offsetWidth;
  dom.tapPad.classList.add("is-hit");
  window.setTimeout(() => dom.tapPad.classList.remove("is-hit"), 120);
}

function getMetronomeLeak(event) {
  if (state.inputSource !== "mic" || !dom.soundToggle.checked) {
    return { isLeak: false, clickTimeMs: null, deltaMs: null };
  }

  const clickTimeMs = metronome.getNearestClickTime(event.timeMs);
  if (clickTimeMs === null) {
    return { isLeak: false, clickTimeMs: null, deltaMs: null };
  }

  const deltaMs = event.timeMs - clickTimeMs;
  const suppressMs = APP_CONFIG.input.metronomeClickSuppressMs;
  const isInSuppressWindow = Math.abs(deltaMs) <= suppressMs;

  return {
    isLeak: isInSuppressWindow && !isStrongUserOnset(event),
    clickTimeMs,
    deltaMs
  };
}

function isStrongUserOnset(event) {
  const threshold = Number(event.threshold) || 0;
  const onsetScore = Number(event.onsetScore) || 0;
  const energy = Number(event.energy) || 0;
  return onsetScore > threshold * 1.8 || energy > APP_CONFIG.input.noiseGate * 2.2;
}

function getAlignedMicTime(rawTimeMs) {
  if (state.micAlignmentOffsetMs === null) {
    const info = metronome.getCurrentPassInfo(rawTimeMs);
    if (!info) {
      return rawTimeMs;
    }

    state.micAlignmentOffsetMs = clamp(rawTimeMs - info.startedAtMs, 0, info.durationMs);
    addDebugEvent(`mic alignment set ${formatDebugMs(state.micAlignmentOffsetMs)}ms`);
  }

  return rawTimeMs - state.micAlignmentOffsetMs;
}

function getRuntimeDebug() {
  const lastClickTimeMs = metronome.getLastClickTime();
  return {
    source: state.inputSource,
    soundEnabled: dom.soundToggle.checked,
    audioState: metronome.getAudioState(),
    lastMetronomeClickMs: lastClickTimeMs,
    micAlignmentOffsetMs: state.micAlignmentOffsetMs,
    events: state.debugEvents
  };
}

function addDebugEvent(message) {
  state.debugEvents.push({
    timeMs: performance.now(),
    message
  });
  state.debugEvents = state.debugEvents.slice(-5);
}

function formatRecordedHitEvent(source, rawTimeMs, recordedTimeMs, passIndex, hitMs, micAlignmentOffsetMs) {
  if (source !== "mic") {
    return `${source} hit ${formatDebugMs(recordedTimeMs)} recorded: pass ${passIndex}, hit ${formatDebugMs(hitMs)}ms`;
  }

  return `mic hit raw ${formatDebugMs(rawTimeMs)}, align ${formatDebugMs(micAlignmentOffsetMs)}, adjusted ${formatDebugMs(recordedTimeMs)} recorded: pass ${passIndex}, hit ${formatDebugMs(hitMs)}ms`;
}

function getSettings() {
  return {
    meter: dom.meterSelect.value,
    bpm: Number(dom.bpmInput.value) || 96,
    clickMode: getRadioValue("clickMode"),
    soundEnabled: dom.soundToggle.checked
  };
}

function getPasses() {
  return [...state.passMap.values()].sort((a, b) => a.index - b.index);
}

function getRadioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function setRadioValue(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) {
    input.checked = true;
  }
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatDebugMs(value) {
  return Number.isFinite(value) ? value.toFixed(1) : "--";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

window.__rhythmAnalyzer = {
  get state() {
    return state;
  },
  get meter() {
    return getMeterConfig(dom.meterSelect.value);
  },
  get passDurationMs() {
    return getPassDurationMs(getMeterConfig(dom.meterSelect.value), Number(dom.bpmInput.value) || 100);
  }
};
