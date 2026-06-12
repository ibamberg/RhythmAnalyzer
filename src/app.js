import { APP_CONFIG } from "./config.js";
import { getMeterConfig, getPassDurationMs } from "./meter.js";
import { analyzeRhythm } from "./rhythm-core.js";
import { buildTimelineModel, renderSongsterrRhythm } from "./render-core.js";
import { Metronome } from "./metronome.js";
import { MicrophoneOnsetDetector } from "./audio-input.js";
import { bindTapInput } from "./tap-input.js";
import { renderDebugPanel } from "./debug-panel.js";
import { clamp, round } from "./utils.js";

const LATENCY_STORAGE_KEY = "rhythm-analyzer.latencyOffsetMs";
const BLEED_WARNING_COUNT = 6;

const dom = {
  meterSelect: document.querySelector("#meterSelect"),
  bpmInput: document.querySelector("#bpmInput"),
  sensitivityInput: document.querySelector("#sensitivityInput"),
  volumeInput: document.querySelector("#volumeInput"),
  micLevelControl: document.querySelector("#micLevelControl"),
  micLevelFill: document.querySelector("#micLevelFill"),
  micLevelThreshold: document.querySelector("#micLevelThreshold"),
  soundToggle: document.querySelector("#soundToggle"),
  clickModeInputs: [...document.querySelectorAll('input[name="clickMode"]')],
  inputSourceInputs: [...document.querySelectorAll('input[name="inputSource"]')],
  startButton: document.querySelector("#startButton"),
  resetButton: document.querySelector("#resetButton"),
  debugToggle: document.querySelector("#debugToggle"),
  calibrateButton: document.querySelector("#calibrateButton"),
  tapPad: document.querySelector("#tapPad"),
  padLabel: document.querySelector("#padLabel"),
  statusLabel: document.querySelector("#statusLabel"),
  messageLabel: document.querySelector("#messageLabel"),
  confidenceLabel: document.querySelector("#confidenceLabel"),
  beatMarkers: document.querySelector("#beatMarkers"),
  timelineSegments: document.querySelector("#timelineSegments"),
  playhead: document.querySelector("#playhead"),
  debugPanel: document.querySelector("#debugPanel"),
  testPanel: document.querySelector("#testPanel"),
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
  rafId: null,
  // { offsets: [] } во время калибровки задержки, иначе null
  calibration: null,
  latencyOffsetMs: loadStoredLatencyOffset(),
  bleedCount: 0,
  lastTimelineKey: null,
  // Сглаженный уровень для метра: быстрый подъём, медленный спад
  meterPercent: 0
};

// Single AudioContext shared by the metronome and mic detector.
// Created lazily on first user gesture; never closed.
let sharedAudioContext = null;

async function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContextClass();
  }
  if (sharedAudioContext.state === "suspended") {
    await sharedAudioContext.resume();
  }
  return sharedAudioContext;
}

// Все времена ударов и сетки — в шкале часов AudioContext (мс): один источник
// времени для метронома, микрофона и тапа, между ними нет дрейфа.
function nowMs() {
  return sharedAudioContext ? sharedAudioContext.currentTime * 1000 : 0;
}

// Постоянный сдвиг между запланированной сеткой и тем, что пользователь
// слышит и играет: откалиброванное значение, иначе задержка вывода контекста.
function getLatencyOffsetMs() {
  if (Number.isFinite(state.latencyOffsetMs)) {
    return state.latencyOffsetMs;
  }
  return (sharedAudioContext?.outputLatency || 0) * 1000;
}

const metronome = new Metronome({
  onPassStart: handlePassStart,
  onClickScheduled: (time) => micDetector.noteClickScheduled(time)
});

const micDetector = new MicrophoneOnsetDetector({
  onOnset: (event) => {
    if (state.inputSource === "mic") {
      handleUserHit(event.audioTime * 1000);
    }
  },
  onSuppressedOnset: handleSuppressedOnset
});

init();

function init() {
  bindEvents();
  renderApp();
  renderPadState();
  renderSliderFill(dom.sensitivityInput);
  renderSliderFill(dom.volumeInput);
  renderMicThreshold();
  metronome.setVolume(dom.volumeInput.value);
  updateMetronomeSoundState();
  dom.debugToggle.classList.add("is-active");
}

function bindEvents() {
  bindTapInput({
    element: dom.tapPad,
    onTap: () => {
      if (state.calibration || state.inputSource === "tap") {
        handleUserHit(nowMs());
      }
    },
    onVisualHit: flashPad
  });

  dom.startButton.addEventListener("click", () => {
    if (state.calibration) {
      cancelCalibration();
      return;
    }
    if (metronome.isRunning) {
      stop();
    } else {
      start();
    }
  });

  dom.resetButton.addEventListener("click", () => {
    if (state.calibration) {
      cancelCalibration();
    }
    resetRecordingData();
    renderApp();
  });

  dom.calibrateButton.addEventListener("click", () => {
    if (state.calibration) {
      cancelCalibration();
    } else {
      startCalibration();
    }
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
    dom.testPanel.classList.toggle("is-hidden", !state.isDebugVisible);
  });

  window.addEventListener("resize", () => {
    renderTimeline(buildTimelineModel(state.analysisResult));
  });

  for (const control of [dom.meterSelect, dom.bpmInput]) {
    control.addEventListener("change", () => {
      if (metronome.isRunning) {
        // Смена сетки делает записанные проходы несравнимыми — рестарт
        restart();
      } else {
        resetRecordingData();
        renderApp();
      }
    });
  }

  dom.soundToggle.addEventListener("change", async () => {
    updateMetronomeSoundState();
    renderPadState();
    metronome.setSoundEnabled(dom.soundToggle.checked);
    state.bleedCount = 0;
    // AEC нужен только пока метроном звучит — пересоздаём микрофонный тракт
    await restartMicIfRunning();
    renderApp();
  });

  dom.sensitivityInput.addEventListener("input", () => {
    micDetector.setSensitivity(dom.sensitivityInput.value);
    renderSliderFill(dom.sensitivityInput);
    renderMicThreshold();
  });

  dom.volumeInput.addEventListener("input", () => {
    metronome.setVolume(dom.volumeInput.value);
    renderSliderFill(dom.volumeInput);
  });

  for (const input of dom.clickModeInputs) {
    input.addEventListener("change", () => {
      metronome.setClickMode(getRadioValue("clickMode"));
    });
  }

  for (const input of dom.inputSourceInputs) {
    input.addEventListener("change", async () => {
      state.inputSource = getRadioValue("inputSource");
      state.bleedCount = 0;
      renderPadState();
      if (metronome.isRunning) {
        await syncInputSource();
      }
      renderApp();
    });
  }
}

async function start() {
  resetRecordingData();
  state.bleedCount = 0;
  const ctx = await ensureAudioContext();
  await syncInputSource(ctx);
  await metronome.start(getSettings(), ctx);
  dom.startButton.textContent = "Stop";
  dom.startButton.classList.add("is-running");
  startUiLoop();
  renderApp();
}

function stop() {
  metronome.stop();
  micDetector.stop();
  dom.startButton.textContent = "Start";
  dom.startButton.classList.remove("is-running");
  stopUiLoop();
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

async function syncInputSource(ctx = sharedAudioContext) {
  if (state.inputSource !== "mic" && !state.calibration) {
    micDetector.stop();
    return;
  }
  if (state.inputSource !== "mic") {
    return;
  }

  try {
    await micDetector.start(ctx, { echoCancellation: dom.soundToggle.checked });
    // Перевооружаем гейт кликами, которые уже запланированы
    for (const time of metronome.getUpcomingClickTimes()) {
      micDetector.noteClickScheduled(time);
    }
  } catch (error) {
    state.inputSource = "tap";
    setRadioValue("inputSource", "tap");
    renderPadState();
    dom.messageLabel.textContent = "Microphone unavailable";
    console.warn(error);
  }
}

async function restartMicIfRunning() {
  if (state.inputSource === "mic" && micDetector.isRunning) {
    micDetector.stop();
    await syncInputSource();
  }
}

function handleUserHit(hitMs) {
  if (state.calibration) {
    handleCalibrationHit(hitMs);
    return;
  }

  const result = recordHit(hitMs);
  if (result.recorded && state.inputSource === "mic") {
    flashPad();
  }
}

function handleSuppressedOnset() {
  if (state.inputSource !== "mic" || !dom.soundToggle.checked) {
    return;
  }
  state.bleedCount += 1;
  if (state.bleedCount === BLEED_WARNING_COUNT) {
    renderApp();
  }
}

function recordHit(rawHitMs) {
  if (!metronome.isRunning) {
    return { recorded: false, reason: "not-running" };
  }

  const hitMs = rawHitMs - getLatencyOffsetMs();
  const info = metronome.getCurrentPassInfo(hitMs);
  if (!info) {
    return { recorded: false, reason: "no-pass-info" };
  }

  let targetIndex = info.passIndex;
  let targetStartedAtMs = info.startedAtMs;
  let relativeMs = hitMs - targetStartedAtMs;
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
  state.analysisResult = analyzeRhythm({ meter: dom.meterSelect.value, passes: [] });
  dom.playhead.style.left = "0%";
}

// --- Калибровка задержки -------------------------------------------------
// Пользователь тапает под клики; медиана (тап - запланированный клик) даёт
// постоянный сдвиг тракта: задержка вывода + ввода + реакция устройства.

async function startCalibration() {
  if (metronome.isRunning) {
    stop();
  }
  resetRecordingData();
  state.calibration = { offsets: [] };
  dom.calibrateButton.classList.add("is-active");
  const ctx = await ensureAudioContext();
  await syncInputSource(ctx);
  await metronome.start(
    {
      meter: "4/4",
      bpm: APP_CONFIG.calibration.bpm,
      clickMode: "quarter",
      soundEnabled: true
    },
    ctx
  );
  startUiLoop();
  renderApp();
}

function handleCalibrationHit(hitMs) {
  const clickTime = metronome.getNearestClickTime(hitMs / 1000);
  if (clickTime === null) {
    return;
  }

  const offset = hitMs - clickTime * 1000;
  if (Math.abs(offset) > APP_CONFIG.calibration.maxOffsetMs) {
    return;
  }

  state.calibration.offsets.push(offset);
  flashPad();

  if (state.calibration.offsets.length >= APP_CONFIG.calibration.taps) {
    finishCalibration();
  } else {
    renderApp();
  }
}

function finishCalibration() {
  const offset = round(median(state.calibration.offsets), 1);
  state.latencyOffsetMs = offset;
  try {
    localStorage.setItem(LATENCY_STORAGE_KEY, String(offset));
  } catch {
    // приватный режим — оставляем значение только в памяти
  }
  endCalibration();
  dom.messageLabel.textContent = `Latency offset: ${offset >= 0 ? "+" : ""}${offset} ms`;
}

function cancelCalibration() {
  endCalibration();
}

function endCalibration() {
  state.calibration = null;
  dom.calibrateButton.classList.remove("is-active");
  metronome.stop();
  micDetector.stop();
  stopUiLoop();
  resetRecordingData();
  renderApp();
}

function loadStoredLatencyOffset() {
  try {
    const raw = localStorage.getItem(LATENCY_STORAGE_KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// --- Тестовые удары -------------------------------------------------------

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
    stopUiLoop();
  }

  state.passMap.clear();

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

// --- Рендер ----------------------------------------------------------------

function renderApp() {
  const timelineModel = buildTimelineModel(state.analysisResult);
  renderTimeline(timelineModel);
  renderStatus(timelineModel);
  renderDebugPanel(dom.debugPanel, getPasses(), state.analysisResult);
}

function renderTimeline(model) {
  const rhythmWidth = getRhythmRenderWidth();

  // innerHTML-перерисовка дорогая и конкурирует с аудио-планировщиком —
  // пропускаем, если модель не изменилась (удары приходят чаще, чем она)
  const key = JSON.stringify([model.status, model.meterUnits, model.segments, rhythmWidth]);
  if (key === state.lastTimelineKey) {
    return;
  }
  state.lastTimelineKey = key;

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
  dom.messageLabel.textContent = getStatusMessage();
}

function getStatusMessage() {
  if (state.calibration) {
    return `Calibration: tap with the click (${state.calibration.offsets.length}/${APP_CONFIG.calibration.taps})`;
  }

  if (state.inputSource === "mic" && dom.soundToggle.checked) {
    if (state.bleedCount >= BLEED_WARNING_COUNT) {
      return "Metronome bleeds into the mic — use headphones";
    }
    if (!metronome.isRunning) {
      return "Use headphones when mic + sound are both on";
    }
  }

  return state.analysisResult.message;
}

function renderPadState() {
  const isMic = state.inputSource === "mic";
  const showHeadphoneWarning = isMic && dom.soundToggle.checked;
  dom.tapPad.classList.toggle("is-listening", isMic);
  dom.tapPad.classList.toggle("is-headphone-warning", showHeadphoneWarning);
  dom.micLevelControl.classList.toggle("is-inactive", !isMic);
  dom.padLabel.textContent = isMic ? "Mic" : "Tap";
}

function renderSliderFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = clamp(((value - min) / (max - min)) * 100, 0, 100);
  input.style.setProperty("--slider-fill", `${percent}%`);
}

function updateMetronomeSoundState() {
  const isSoundEnabled = dom.soundToggle.checked;
  for (const input of dom.clickModeInputs) {
    input.disabled = !isSoundEnabled;
  }
  dom.volumeInput.disabled = !isSoundEnabled;
}

function flashPad() {
  dom.tapPad.classList.remove("is-hit");
  void dom.tapPad.offsetWidth;
  dom.tapPad.classList.add("is-hit");
  window.setTimeout(() => dom.tapPad.classList.remove("is-hit"), 120);
}

// Один rAF-цикл на всё «живое»: playhead и индикатор уровня микрофона
function startUiLoop() {
  stopUiLoop();
  const frame = () => {
    if (metronome.isRunning) {
      const info = metronome.getCurrentPassInfo(nowMs() - getLatencyOffsetMs());
      if (info) {
        dom.playhead.style.left = `${info.progress * 100}%`;
      }
    }
    renderMicLevel();
    state.rafId = requestAnimationFrame(frame);
  };
  state.rafId = requestAnimationFrame(frame);
}

function stopUiLoop() {
  cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.meterPercent = 0;
  applyMeterFill(0);
}

function renderMicLevel() {
  const target = levelToPercent(micDetector.getLevel());
  // Баллистика метра: подъём мгновенный, спад плавный
  state.meterPercent = target >= state.meterPercent ? target : state.meterPercent * 0.92;
  applyMeterFill(state.meterPercent);
}

function applyMeterFill(percent) {
  dom.micLevelFill.style.clipPath = `inset(0 ${round(100 - percent, 1)}% 0 0)`;
}

// Отметка на метре: уровень, с которого детектор начинает ловить удары.
// Перевод порога онсет-детектора (flux-домен) в RMS-шкалу метра приближённый:
// для перкуссивного транзиента onsetScore ~ 0.6 * пикового RMS.
function renderMicThreshold() {
  const sensitivity = Number(dom.sensitivityInput.value);
  const onsetFloor = 0.0035 + (1 - sensitivity) * 0.018;
  const approxRms = onsetFloor / 0.6;
  dom.micLevelThreshold.style.left = `${round(levelToPercent(approxRms), 1)}%`;
}

// RMS 0..1 -> проценты по дБ-шкале -60..0
function levelToPercent(rms) {
  if (rms <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(rms);
  return clamp(((db + 60) / 60) * 100, 0, 100);
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
