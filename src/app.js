import { APP_CONFIG } from "./config.js";
import { getMeterConfig, getPassDurationMs } from "./meter.js";
import { analyzeRhythm } from "./rhythm-core.js?v=5";
import { buildTimelineModel, renderSongsterrRhythm } from "./render-core.js?v=4";
import { Metronome } from "./metronome.js?v=4";
import { MicrophoneOnsetDetector } from "./audio-input.js?v=2";
import { bindTapInput } from "./tap-input.js?v=2";
import { renderDebugPanel } from "./debug-panel.js?v=2";

const dom = {
  meterSelect: document.querySelector("#meterSelect"),
  bpmInput: document.querySelector("#bpmInput"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  soundToggle: document.querySelector("#soundToggle"),
  clickModeInputs: [...document.querySelectorAll('input[name="clickMode"]')],
  inputSourceInputs: [...document.querySelectorAll('input[name="inputSource"]')],
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
  analysisResult: analyzeRhythm({ meter: "4/4", passes: [] }),
  isDebugVisible: true,
  inputSource: "tap",
  micAlignmentOffsetMs: null,
  rafId: null
};

const metronome = new Metronome({
  onPassStart: handlePassStart
});

const micDetector = new MicrophoneOnsetDetector({
  onOnset: (event) => {
    if (state.inputSource === "mic") {
      handleMicOnset(event);
    }
  }
});

init();

function init() {
  bindEvents();
  renderApp();
  renderPadState();
  renderSensitivityFill();
  updateMetronomeSoundState();
  dom.debugToggle.classList.add("is-active");
}

function bindEvents() {
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
    resetRecordingData();
    renderApp();
  });

  dom.testApplyButton.addEventListener("click", applyTestHits);

  dom.testClearButton.addEventListener("click", () => {
    dom.testHitsInput.value = "";
    resetRecordingData();
    renderApp();
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
        resetRecordingData();
        renderApp();
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
    renderSensitivityFill();
  });

  for (const input of dom.clickModeInputs) {
    input.addEventListener("change", () => {
      if (metronome.isRunning) {
        restart();
      }
    });
  }

  for (const input of dom.inputSourceInputs) {
    input.addEventListener("change", async () => {
      state.inputSource = getRadioValue("inputSource");
      renderPadState();
      if (metronome.isRunning) {
        await syncInputSource();
        renderApp();
      }
    });
  }
}

async function start() {
  resetRecordingData();
  await metronome.ensureAudioReady();
  await syncInputSource();
  await metronome.start(getSettings());
  dom.startButton.textContent = "Stop";
  dom.startButton.classList.add("is-running");
  startPlayhead();
  renderApp();
}

function stop() {
  metronome.stop();
  micDetector.stop();
  dom.startButton.textContent = "Start";
  dom.startButton.classList.remove("is-running");
  stopPlayhead();
  renderApp();
}

async function restart() {
  stop();
  await start();
}

function handlePassStart(pass) {
  ensurePass(pass.index, pass.startedAtMs, pass.durationMs);
  prunePasses();
  refreshAnalysis();
}

async function syncInputSource() {
  if (state.inputSource !== "mic") {
    micDetector.stop();
    return;
  }

  try {
    await micDetector.start();
  } catch (error) {
    state.inputSource = "tap";
    setRadioValue("inputSource", "tap");
    renderPadState();
    dom.messageLabel.textContent = "Microphone unavailable";
    console.warn(error);
  }
}

function handleMicOnset(event) {
  const leak = getMetronomeLeak(event);
  if (leak.isLeak) {
    renderApp();
    return;
  }

  const alignedTimeMs = getAlignedMicTime(event.timeMs);
  const result = recordHit(alignedTimeMs);
  if (result.recorded) {
    flashPad();
  }
}

function recordHit(hitPerfMs) {
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
  const sortedIndexes = [...state.passMap.keys()].sort((a, b) => a - b);
  while (sortedIndexes.length > APP_CONFIG.analysis.maxStoredPasses) {
    const index = sortedIndexes.shift();
    state.passMap.delete(index);
  }
}

function refreshAnalysis() {
  const meter = dom.meterSelect.value;
  const passes = getPasses().filter((pass) => pass.hitsMs.length > 0);
  state.analysisResult = analyzeRhythm({ meter, passes });
  renderApp();
}

function resetRecordingData() {
  state.passMap.clear();
  state.micAlignmentOffsetMs = null;
  state.analysisResult = analyzeRhythm({ meter: dom.meterSelect.value, passes: [] });
  dom.playhead.style.left = "0%";
}

function applyTestHits() {
  const meter = getMeterConfig(dom.meterSelect.value);
  const durationMs = getPassDurationMs(meter, Number(dom.bpmInput.value) || 96);
  const parsed = parseTestHits(dom.testHitsInput.value);

  if (!parsed.ok) {
    dom.messageLabel.textContent = parsed.message;
    renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult);
    return;
  }

  const hitsMs = dom.testHitMode.value === "ms"
    ? parsed.values
    : parsed.values.map((position) => (position / meter.unitsPerPass) * durationMs);
  const sanitizedHits = hitsMs
    .filter((hit) => Number.isFinite(hit) && hit >= 0 && hit < durationMs)
    .map((hit) => round(hit, 3))
    .sort((a, b) => a - b);

  if (!sanitizedHits.length) {
    dom.messageLabel.textContent = "No valid test hits";
    renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult);
    return;
  }

  if (metronome.isRunning) {
    stop();
  } else {
    stopPlayhead();
  }

  state.passMap.clear();
  state.micAlignmentOffsetMs = null;

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
  renderApp();
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

function renderApp() {
  const timelineModel = buildTimelineModel(state.analysisResult);
  renderTimeline(timelineModel);
  renderStatus(timelineModel);
  renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult);
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

function renderStatus(model) {
  dom.statusLabel.textContent = model.status;
  dom.confidenceLabel.textContent = `${Math.round(model.confidence * 100)}%`;
  dom.messageLabel.textContent = state.analysisResult.message;
}

function renderPadState() {
  state.inputSource = getRadioValue("inputSource");
  dom.tapPad.classList.toggle("is-listening", state.inputSource === "mic");
  dom.padLabel.textContent = state.inputSource === "mic" ? "Mic" : "Tap";
}

function renderSensitivityFill() {
  const min = Number(dom.sensitivityInput.min);
  const max = Number(dom.sensitivityInput.max);
  const value = Number(dom.sensitivityInput.value);
  const percent = clamp(((value - min) / (max - min)) * 100, 0, 100);
  dom.sensitivityInput.style.setProperty("--sensitivity-fill", `${percent}%`);
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

  return {
    isLeak: Math.abs(deltaMs) <= suppressMs && !isStrongUserOnset(event),
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
  }

  return rawTimeMs - state.micAlignmentOffsetMs;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
