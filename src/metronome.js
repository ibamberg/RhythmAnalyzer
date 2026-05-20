import {
  getClickPositions,
  getMeterConfig,
  getPassDurationMs,
  isStrongPosition
} from "./config.js";

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.14;
const CLICK_VOLUME = {
  strong: 0.58,
  weak: 0.34
};

export class Metronome {
  constructor({ onPassStart = () => {}, onTick = () => {} } = {}) {
    this.onPassStart = onPassStart;
    this.onTick = onTick;
    this.audioContext = null;
    this.timerId = null;
    this.boundaryTimerId = null;
    this.isRunning = false;
    this.lastEmittedPassIndex = -1;
    this.lastScheduledClickPerfMs = null;
  }

  async ensureAudioReady() {
    if (!this.audioContext || this.audioContext.state === "closed") {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass();
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  async start(settings) {
    if (this.isRunning) {
      this.stop();
    }

    this.settings = normalizeSettings(settings);
    this.meter = getMeterConfig(this.settings.meter);
    this.passDurationMs = getPassDurationMs(this.meter, this.settings.bpm);
    this.clickPositions = getClickPositions(this.meter, this.settings.clickMode);

    await this.ensureAudioReady();

    const startDelaySeconds = 0.08;
    this.startAudioTime = this.audioContext.currentTime + startDelaySeconds;
    this.startPerfMs = performance.now() + startDelaySeconds * 1000;
    this.nextClickIndex = 0;
    this.nextClickTime = this.startAudioTime;
    this.lastEmittedPassIndex = -1;
    this.lastScheduledClickPerfMs = null;
    this.isRunning = true;

    this.timerId = window.setInterval(() => this.scheduler(), LOOKAHEAD_MS);
    this.boundaryTimerId = window.setInterval(() => this.emitPassBoundaries(), 12);
    this.scheduler();
    this.emitPassBoundaries();
  }

  stop() {
    this.isRunning = false;
    window.clearInterval(this.timerId);
    window.clearInterval(this.boundaryTimerId);
    this.timerId = null;
    this.boundaryTimerId = null;
  }

  getCurrentPassInfo(atPerfMs = performance.now()) {
    if (!this.settings) {
      return null;
    }

    const elapsedMs = atPerfMs - this.startPerfMs;
    const passIndex = Math.max(0, Math.floor(Math.max(0, elapsedMs) / this.passDurationMs));
    const startedAtMs = this.startPerfMs + passIndex * this.passDurationMs;
    const elapsedInPassMs = Math.max(0, atPerfMs - startedAtMs);

    return {
      passIndex,
      startedAtMs,
      durationMs: this.passDurationMs,
      elapsedInPassMs,
      progress: clamp(elapsedInPassMs / this.passDurationMs, 0, 1)
    };
  }

  getAudioState() {
    return this.audioContext?.state || "not-created";
  }

  getNearestClickTime(atPerfMs = performance.now()) {
    if (!this.settings || !this.clickPositions?.length || !Number.isFinite(this.startPerfMs)) {
      return null;
    }

    const elapsedMs = atPerfMs - this.startPerfMs;
    const currentPassIndex = Math.floor(elapsedMs / this.passDurationMs);
    let nearestTime = null;
    let nearestDistance = Infinity;

    for (const passIndex of [currentPassIndex - 1, currentPassIndex, currentPassIndex + 1]) {
      if (passIndex < 0) {
        continue;
      }

      for (const position of this.clickPositions) {
        const clickTime = this.getClickPerfTime(passIndex, position);
        const distance = Math.abs(atPerfMs - clickTime);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestTime = clickTime;
        }
      }
    }

    return nearestTime;
  }

  getLastClickTime(atPerfMs = performance.now()) {
    if (!this.settings || !this.clickPositions?.length || !Number.isFinite(this.startPerfMs)) {
      return null;
    }

    const elapsedMs = atPerfMs - this.startPerfMs;
    const currentPassIndex = Math.max(0, Math.floor(Math.max(0, elapsedMs) / this.passDurationMs));
    let lastClickTime = null;

    for (const passIndex of [currentPassIndex - 1, currentPassIndex]) {
      if (passIndex < 0) {
        continue;
      }

      for (const position of this.clickPositions) {
        const clickTime = this.getClickPerfTime(passIndex, position);
        if (clickTime <= atPerfMs && (lastClickTime === null || clickTime > lastClickTime)) {
          lastClickTime = clickTime;
        }
      }
    }

    return lastClickTime;
  }

  scheduler() {
    if (!this.isRunning || !this.audioContext) {
      return;
    }

    while (
      this.nextClickTime <
      this.audioContext.currentTime + SCHEDULE_AHEAD_SECONDS
    ) {
      const click = this.getClickAtIndex(this.nextClickIndex);
      this.lastScheduledClickPerfMs = this.startPerfMs + click.offsetMs;
      if (this.settings.soundEnabled) {
        this.scheduleClick(this.nextClickTime, click.strong);
      }
      this.onTick({
        passIndex: click.passIndex,
        position: click.position,
        strong: click.strong,
        time: this.nextClickTime,
        perfTimeMs: this.lastScheduledClickPerfMs
      });

      this.nextClickIndex += 1;
      const nextClick = this.getClickAtIndex(this.nextClickIndex);
      this.nextClickTime = this.startAudioTime + nextClick.offsetMs / 1000;
    }
  }

  emitPassBoundaries() {
    if (!this.isRunning) {
      return;
    }

    const info = this.getCurrentPassInfo();
    if (!info || performance.now() < this.startPerfMs) {
      return;
    }

    while (this.lastEmittedPassIndex < info.passIndex) {
      this.lastEmittedPassIndex += 1;
      this.onPassStart({
        index: this.lastEmittedPassIndex,
        startedAtMs: this.startPerfMs + this.lastEmittedPassIndex * this.passDurationMs,
        durationMs: this.passDurationMs,
        hitsMs: []
      });
    }
  }

  getClickAtIndex(globalClickIndex) {
    const clicksPerPass = this.clickPositions.length;
    const passIndex = Math.floor(globalClickIndex / clicksPerPass);
    const clickIndexInPass = globalClickIndex % clicksPerPass;
    const position = this.clickPositions[clickIndexInPass];
    const unitMs = this.passDurationMs / this.meter.unitsPerPass;

    return {
      passIndex,
      position,
      offsetMs: passIndex * this.passDurationMs + position * unitMs,
      strong: isStrongPosition(this.meter, position)
    };
  }

  getClickPerfTime(passIndex, position) {
    const unitMs = this.passDurationMs / this.meter.unitsPerPass;
    return this.startPerfMs + passIndex * this.passDurationMs + position * unitMs;
  }

  scheduleClick(time, strong) {
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    const duration = strong ? 0.055 : 0.04;
    const volume = strong ? CLICK_VOLUME.strong : CLICK_VOLUME.weak;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(strong ? 1420 : 860, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(volume, time + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    oscillator.connect(gain);
    gain.connect(this.audioContext.destination);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.02);
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
