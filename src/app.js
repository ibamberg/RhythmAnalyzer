import { APP_CONFIG, getMeterConfig, getPassDurationMs } from "./config.js";
import { analyzeRhythm } from "./rhythm-core.js";
import { buildTimelineModel } from "./render-core.js";
import { Metronome } from "./metronome.js";
import { MicrophoneOnsetDetector } from "./audio-input.js";
import { bindTapInput } from "./tap-input.js";
import { renderDebugPanel } from "./debug-panel.js";

const dom = {
  meterSelect: document.querySelector("#meterSelect"),
  bpmInput: document.querySelector("#bpmInput"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  soundToggle: document.querySelector("#soundToggle"),
  startButton: document.querySelector("#startButton"),
  resetButton: document.querySelector("#resetButton"),
  debugToggle: document.querySelector("#debugToggle"),
  tapPad: document.querySelector("#tapPad"),
  padLabel: document.querySelector("#padLabel"),
  micMeter: document.querySelector("#micMeter"),
  micMeterTrack: document.querySelector("#micMeter .mic-meter__track"),
  micMeterValue: document.querySelector("#micMeterValue"),
  micMeterThresholdValue: document.querySelector("#micMeterThresholdValue"),
  statusLabel: document.querySelector("#statusLabel"),
  messageLabel: document.querySelector("#messageLabel"),
  confidenceLabel: document.querySelector("#confidenceLabel"),
  beatMarkers: document.querySelector("#beatMarkers"),
  timelineSegments: document.querySelector("#timelineSegments"),
  playhead: document.querySelector("#playhead"),
  debugPanel: document.querySelector("#debugPanel")
};

const MIC_METER_BASE_MAX = 0.04;
const MIC_METER_DECAY = 0.985;

const state = {
  passMap: new Map(),
  currentPassIndex: null,
  analysisResult: analyzeRhythm({ meter: "4/4", passes: [] }),
  isDebugVisible: true,
  inputSource: "tap",
  micDebug: null,
  micMeterMax: MIC_METER_BASE_MAX,
  micAlignmentOffsetMs: null,
  isStarting: false,
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
    if (state.inputSource === "mic" && metronome.isRunning) {
      handleMicOnset(event);
    }
  },
  onLevel: (frame) => {
    if (state.inputSource !== "mic") {
      return;
    }
    state.micDebug = frame;
    const level = clamp(frame.energy * 11 + frame.onsetScore * 18, 0, 1);
    document.documentElement.style.setProperty("--input-level", String(level));
    updateMicMeter(frame);
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

const startPrimeEvent = window.PointerEvent ? "pointerdown" : "touchstart";
dom.startButton.addEventListener(startPrimeEvent, () => {
  if (!metronome.isRunning && dom.soundToggle.checked) {
    metronome.primeAudioFromGesture();
  }
}, { passive: true });

dom.startButton.addEventListener("click", async () => {
  if (state.isStarting) {
    return;
  }

  if (metronome.isRunning) {
    stop();
  } else {
    await start();
  }
});

dom.resetButton.addEventListener("click", () => {
  resetData();
  render();
});

dom.debugToggle.addEventListener("click", () => {
  state.isDebugVisible = !state.isDebugVisible;
  dom.debugToggle.classList.toggle("is-active", state.isDebugVisible);
  dom.debugPanel.classList.toggle("is-hidden", !state.isDebugVisible);
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
  if (metronome.isRunning) {
    restart();
  }
});

dom.sensitivityInput.addEventListener("input", () => {
  micDetector.setSensitivity(dom.sensitivityInput.value);
  updateMicMeter(state.micDebug);
});

document.querySelectorAll('input[name="clickMode"]').forEach((input) => {
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
    await syncInputSource();
    render();
  });
});

render();
updatePadMode();
syncInputSource();
dom.debugToggle.classList.add("is-active");

async function start() {
  state.isStarting = true;
  dom.startButton.disabled = true;
  dom.startButton.textContent = "Wait";

  try {
    resetData();
    addDebugEvent("start requested");
    await metronome.ensureAudioReady({ unlock: dom.soundToggle.checked });
    addDebugEvent(`metronome audio ${metronome.getAudioState()}`);
    const requestedInputSource = state.inputSource;
    const inputReady = await syncInputSource();
    if (requestedInputSource === "mic" && !inputReady) {
      render();
      return;
    }

    await metronome.start(getSettings());
    addDebugEvent(`metronome clock started, sound ${dom.soundToggle.checked ? "on" : "off"}`);
    dom.startButton.textContent = "Stop";
    dom.startButton.classList.add("is-running");
    startPlayhead();
    render();
  } finally {
    state.isStarting = false;
    dom.startButton.disabled = false;
    if (!metronome.isRunning) {
      dom.startButton.textContent = "Start";
      dom.startButton.classList.remove("is-running");
    }
  }
}

function stop() {
  metronome.stop();
  if (state.inputSource !== "mic") {
    micDetector.stop();
  }
  addDebugEvent("stopped");
  dom.startButton.textContent = "Start";
  dom.startButton.classList.remove("is-running");
  stopPlayhead();
  if (state.inputSource === "mic" && micDetector.isRunning) {
    updateMicMeter(state.micDebug);
  } else {
    document.documentElement.style.setProperty("--input-level", "0");
    updateMicMeter(null);
  }
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
      if (state.inputSource !== "mic") {
        micDetector.stop();
        document.documentElement.style.setProperty("--input-level", "0");
        updateMicMeter(null);
        return false;
      }

      addDebugEvent("microphone ready");
      updateMicMeter(state.micDebug);
      return true;
    } catch (error) {
      state.inputSource = "tap";
      setRadioValue("inputSource", "tap");
      updatePadMode();
      document.documentElement.style.setProperty("--input-level", "0");
      dom.messageLabel.textContent = "Microphone unavailable";
      addDebugEvent("microphone unavailable");
      console.warn(error);
      return false;
    }
  } else {
    micDetector.stop();
    document.documentElement.style.setProperty("--input-level", "0");
    updateMicMeter(null);
    return false;
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

function render() {
  const timelineModel = buildTimelineModel(state.analysisResult);
  renderTimeline(timelineModel);
  renderStatus(timelineModel);
  renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult, getRuntimeDebug());
}

function renderTimeline(model) {
  dom.beatMarkers.innerHTML = model.beatMarkers
    .map(
      (marker) => `
        <div class="beat-marker ${marker.strong ? "is-strong" : ""}" style="left:${marker.positionPercent}%">
          <span>${marker.label}</span>
        </div>
      `
    )
    .join("");

  dom.timelineSegments.innerHTML = model.segments
    .map((segment) => {
      const smallClass = segment.widthPercent < 8 ? "is-small" : "";
      return `
        <div class="note-segment ${smallClass}" style="width:${segment.widthPercent}%" title="${segment.label}">
          <span class="glyph">${segment.glyph}</span>
          <span class="label">${segment.label}</span>
        </div>
      `;
    })
    .join("");
}

function renderStatus(model) {
  dom.statusLabel.textContent = model.status;
  dom.confidenceLabel.textContent = `${Math.round(model.confidence * 100)}%`;
  dom.messageLabel.textContent = state.analysisResult.message;
}

function resetData() {
  state.passMap.clear();
  state.currentPassIndex = null;
  state.micDebug = null;
  state.micMeterMax = MIC_METER_BASE_MAX;
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
  updateMicMeter(state.micDebug);
}

function updateMicMeter(frame) {
  const isVisible = state.inputSource === "mic" && micDetector.isRunning;
  dom.micMeter.classList.toggle("is-hidden", !isVisible);
  dom.micMeter.setAttribute("aria-hidden", String(!isVisible));

  if (!isVisible) {
    resetMicMeterDisplay();
    return;
  }

  const attackLevel = Math.max(0, Number(frame?.onsetScore) || 0);
  const threshold = Math.max(0, Number(frame?.threshold) || getIdleMicThreshold());
  const targetMax = Math.max(MIC_METER_BASE_MAX, threshold * 3.2, attackLevel * 1.18);
  state.micMeterMax = Math.max(targetMax, state.micMeterMax * MIC_METER_DECAY);

  const levelRatio = clamp(attackLevel / state.micMeterMax, 0, 1);
  const thresholdRatio = clamp(threshold / state.micMeterMax, 0, 1);
  const levelPercent = Math.round(levelRatio * 100);

  dom.micMeter.style.setProperty("--mic-level-scale", levelRatio.toFixed(4));
  dom.micMeter.style.setProperty("--mic-threshold-position", `${(thresholdRatio * 100).toFixed(2)}%`);
  dom.micMeter.classList.toggle("is-over-threshold", isAttackLevel(frame, attackLevel, threshold));
  dom.micMeterValue.textContent = formatSignal(attackLevel);
  dom.micMeterThresholdValue.textContent = `attack ${formatSignal(threshold)}`;
  dom.micMeterTrack.setAttribute("aria-valuenow", String(levelPercent));
  dom.micMeterTrack.setAttribute(
    "aria-valuetext",
    `signal ${formatSignal(attackLevel)}, attack threshold ${formatSignal(threshold)}`
  );
}

function resetMicMeterDisplay() {
  state.micMeterMax = MIC_METER_BASE_MAX;
  dom.micMeter.style.setProperty("--mic-level-scale", "0");
  dom.micMeter.style.setProperty("--mic-threshold-position", "0%");
  dom.micMeter.classList.remove("is-over-threshold");
  dom.micMeterValue.textContent = "0.00000";
  dom.micMeterThresholdValue.textContent = `attack ${formatSignal(getIdleMicThreshold())}`;
  dom.micMeterTrack.setAttribute("aria-valuenow", "0");
  dom.micMeterTrack.setAttribute("aria-valuetext", "signal 0.00000");
}

function isAttackLevel(frame, attackLevel, threshold) {
  if (!frame) {
    return false;
  }

  const energy = Number(frame.energy) || 0;
  const aboveGate = energy >= APP_CONFIG.input.noiseGate || attackLevel > threshold * 1.35;
  return aboveGate && attackLevel > threshold;
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

function formatSignal(value) {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function getIdleMicThreshold() {
  const sensitivity = clamp(Number(dom.sensitivityInput.value) || APP_CONFIG.input.sensitivity, 0.2, 0.95);
  return Math.max(0.0035 + (1 - sensitivity) * 0.018, APP_CONFIG.input.noiseGate * 0.08);
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
    return getPassDurationMs(getMeterConfig(dom.meterSelect.value), Number(dom.bpmInput.value) || 96);
  }
};
