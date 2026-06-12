import {
  getMetronomeClickUnits,
  getMeterConfig,
  getPassDurationMs,
  isStrongPosition
} from "./meter.js";
import { clamp } from "./utils.js";

const TICK_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.35;
const START_DELAY_SECONDS = 0.08;
const CLICK_NOISE_SECONDS = 0.018;

// Всё время — в шкале часов AudioContext. Миллисекунды в публичном API
// (startedAtMs, getCurrentPassInfo) означают audioContext.currentTime * 1000.
export class Metronome {
  constructor({ onPassStart = () => {}, onClickScheduled = () => {} } = {}) {
    this.onPassStart = onPassStart;
    this.onClickScheduled = onClickScheduled;
    this.audioContext = null;
    this.timerId = null;
    this.isRunning = false;
    this.lastEmittedPassIndex = -1;
    this.noiseBuffer = null;
    this.masterGain = null;
    this.volume = 0.7;
  }

  async start(settings, ctx) {
    if (this.isRunning) {
      this.stop();
    }

    this.settings = normalizeSettings(settings);
    this.meter = getMeterConfig(this.settings.meter);
    this.passDurationMs = getPassDurationMs(this.meter, this.settings.bpm);
    this.clickPositions = getMetronomeClickUnits(this.meter, this.settings.clickMode);
    this.audioContext = ctx;

    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    this.ensureMasterGain(ctx);

    this.startTime = ctx.currentTime + START_DELAY_SECONDS;
    this.nextClickIndex = 0;
    this.lastEmittedPassIndex = -1;
    this.isRunning = true;

    this.timerId = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    this.isRunning = false;
    window.clearInterval(this.timerId);
    this.timerId = null;
  }

  get startMs() {
    return this.startTime * 1000;
  }

  nowMs() {
    return this.audioContext ? this.audioContext.currentTime * 1000 : 0;
  }

  setSoundEnabled(enabled) {
    if (this.settings) {
      this.settings.soundEnabled = enabled !== false;
    }
  }

  // value 0..1; квадратичная кривая ближе к восприятию громкости.
  // Выше 1.0 итогового гейна не поднимаемся — иначе вернётся клиппинг,
  // ломающий notch-фильтры на микрофонном тракте.
  setVolume(value) {
    const parsed = Number(value);
    this.volume = clamp(Number.isFinite(parsed) ? parsed : 0.7, 0, 1);
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(
        this.getMasterGainValue(),
        this.audioContext.currentTime,
        0.02
      );
    }
  }

  getMasterGainValue() {
    return this.volume * this.volume;
  }

  ensureMasterGain(ctx) {
    if (!this.masterGain || this.masterGain.context !== ctx) {
      this.masterGain = ctx.createGain();
      this.masterGain.connect(ctx.destination);
    }
    this.masterGain.gain.value = this.getMasterGainValue();
  }

  // Меняет плотность кликов на лету, не сбрасывая сетку тактов и записанные
  // проходы. Новая сетка вступает после уже запланированных кликов.
  setClickMode(clickMode) {
    if (!this.isRunning) {
      return;
    }

    const mode = clickMode === "eighth" ? "eighth" : "quarter";
    if (this.settings.clickMode === mode) {
      return;
    }

    this.settings.clickMode = mode;
    this.clickPositions = getMetronomeClickUnits(this.meter, mode);

    const fromTime = this.audioContext.currentTime + SCHEDULE_AHEAD_SECONDS;
    const passDurationSec = this.passDurationMs / 1000;
    let index =
      Math.max(0, Math.floor((fromTime - this.startTime) / passDurationSec)) *
      this.clickPositions.length;
    while (this.getClickTime(index) < fromTime) {
      index += 1;
    }
    this.nextClickIndex = index;
  }

  getCurrentPassInfo(atMs = this.nowMs()) {
    if (!this.settings) {
      return null;
    }

    const elapsedMs = atMs - this.startMs;
    const passIndex = Math.max(0, Math.floor(Math.max(0, elapsedMs) / this.passDurationMs));
    const startedAtMs = this.startMs + passIndex * this.passDurationMs;
    const elapsedInPassMs = Math.max(0, atMs - startedAtMs);

    return {
      passIndex,
      startedAtMs,
      durationMs: this.passDurationMs,
      elapsedInPassMs,
      progress: clamp(elapsedInPassMs / this.passDurationMs, 0, 1)
    };
  }

  // Время (в секундах AudioContext) ближайшего клика к заданному моменту.
  getNearestClickTime(atSeconds) {
    if (!this.settings || !this.clickPositions?.length || !Number.isFinite(this.startTime)) {
      return null;
    }

    const passDurationSec = this.passDurationMs / 1000;
    const elapsedSec = atSeconds - this.startTime;
    const currentPassIndex = Math.max(0, Math.floor(Math.max(0, elapsedSec) / passDurationSec));
    const unitSec = passDurationSec / this.meter.unitsPerPass;
    let nearestTime = null;
    let nearestDistance = Infinity;

    for (const passIndex of [currentPassIndex - 1, currentPassIndex, currentPassIndex + 1]) {
      if (passIndex < 0) continue;
      for (const position of this.clickPositions) {
        const clickTime = this.startTime + passIndex * passDurationSec + position * unitSec;
        const distance = Math.abs(atSeconds - clickTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestTime = clickTime;
        }
      }
    }

    return nearestTime;
  }

  // Уже запланированные, но ещё не прозвучавшие клики — чтобы перевооружить
  // гейт микрофона после его перезапуска.
  getUpcomingClickTimes() {
    if (!this.isRunning || !this.settings?.soundEnabled) {
      return [];
    }

    const now = this.audioContext.currentTime;
    const times = [];
    const lookBack = this.clickPositions.length * 2;

    for (let index = Math.max(0, this.nextClickIndex - lookBack); index < this.nextClickIndex; index += 1) {
      const time = this.getClickTime(index);
      if (time > now - 0.2) {
        times.push(time);
      }
    }

    return times;
  }

  getClickTime(globalClickIndex) {
    const clicksPerPass = this.clickPositions.length;
    const passIndex = Math.floor(globalClickIndex / clicksPerPass);
    const position = this.clickPositions[globalClickIndex % clicksPerPass];
    const unitSec = this.passDurationMs / 1000 / this.meter.unitsPerPass;
    return this.startTime + (passIndex * this.passDurationMs) / 1000 + position * unitSec;
  }

  tick() {
    if (!this.isRunning || !this.audioContext) {
      return;
    }
    this.scheduleClicks();
    this.emitPassBoundaries();
  }

  scheduleClicks() {
    const horizon = this.audioContext.currentTime + SCHEDULE_AHEAD_SECONDS;

    while (this.getClickTime(this.nextClickIndex) < horizon) {
      if (this.settings.soundEnabled) {
        const time = this.getClickTime(this.nextClickIndex);
        const position = this.clickPositions[this.nextClickIndex % this.clickPositions.length];
        this.scheduleClick(time, isStrongPosition(this.meter, position));
        this.onClickScheduled(time);
      }
      this.nextClickIndex += 1;
    }
  }

  emitPassBoundaries() {
    if (this.audioContext.currentTime < this.startTime) {
      return;
    }

    const info = this.getCurrentPassInfo();
    if (!info) {
      return;
    }

    while (this.lastEmittedPassIndex < info.passIndex) {
      this.lastEmittedPassIndex += 1;
      this.onPassStart({
        index: this.lastEmittedPassIndex,
        startedAtMs: this.startMs + this.lastEmittedPassIndex * this.passDurationMs,
        durationMs: this.passDurationMs
      });
    }
  }

  // Клик: чистый синус (одна спектральная линия — её вырезает notch на
  // микрофонном тракте) + шумовой щелчок выше 6 кГц (его срезает lowpass).
  // Гейны без клиппинга: клиппинг порождал гармоники по всему спектру.
  scheduleClick(time, strong) {
    const ctx = this.audioContext;
    const duration = strong ? 0.08 : 0.065;
    const toneVolume = strong ? 0.9 : 0.66;
    const noiseVolume = strong ? 0.45 : 0.3;

    const oscillator = ctx.createOscillator();
    const toneGain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(strong ? 1800 : 1100, time);
    toneGain.gain.setValueAtTime(0.0001, time);
    toneGain.gain.exponentialRampToValueAtTime(toneVolume, time + 0.001);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    const noise = ctx.createBufferSource();
    const noiseFilter = ctx.createBiquadFilter();
    const noiseGain = ctx.createGain();
    noise.buffer = this.getNoiseBuffer();
    noiseFilter.type = "highpass";
    noiseFilter.frequency.setValueAtTime(6000, time);
    noiseGain.gain.setValueAtTime(0.0001, time);
    noiseGain.gain.exponentialRampToValueAtTime(noiseVolume, time + 0.001);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + CLICK_NOISE_SECONDS);

    oscillator.connect(toneGain);
    toneGain.connect(this.masterGain);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.masterGain);
    oscillator.start(time);
    noise.start(time);
    oscillator.stop(time + duration + 0.02);
    noise.stop(time + CLICK_NOISE_SECONDS + 0.01);
  }

  getNoiseBuffer() {
    const sampleRate = this.audioContext.sampleRate;
    if (!this.noiseBuffer || this.noiseBuffer.sampleRate !== sampleRate) {
      this.noiseBuffer = this.audioContext.createBuffer(
        1,
        Math.floor(sampleRate * CLICK_NOISE_SECONDS),
        sampleRate
      );
      const data = this.noiseBuffer.getChannelData(0);
      for (let index = 0; index < data.length; index += 1) {
        data[index] = Math.random() * 2 - 1;
      }
    }
    return this.noiseBuffer;
  }
}

function normalizeSettings(settings) {
  return {
    meter: settings.meter,
    bpm: clamp(Number(settings.bpm) || 96, 40, 240),
    clickMode: settings.clickMode === "eighth" ? "eighth" : "quarter",
    soundEnabled: settings.soundEnabled !== false
  };
}
