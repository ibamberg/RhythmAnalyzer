import { APP_CONFIG } from "./config.js";

const PROCESSOR_BUFFER_SIZE = 1024;

export class MicrophoneOnsetDetector {
  constructor({ onOnset = () => {} } = {}) {
    this.onOnset = onOnset;
    this.config = { ...APP_CONFIG.input };
    this.isRunning = false;
    this.lastOnsetAtMs = 0;
    this.previousRms = 0;
    this.previousSample = 0;
    this.averageScore = 0;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.contextPerfOffsetMs = performance.now() - this.audioContext.currentTime * 1000;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (event) => this.processAudio(event);
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);

    this.isRunning = true;
  }

  stop() {
    this.isRunning = false;

    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }

    if (this.source) {
      this.source.disconnect();
    }

    if (this.silentGain) {
      this.silentGain.disconnect();
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    if (this.audioContext) {
      this.audioContext.close();
    }

    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
  }

  setSensitivity(value) {
    this.config.sensitivity = clamp(Number(value) || APP_CONFIG.input.sensitivity, 0.2, 0.95);
  }

  processAudio(event) {
    if (!this.isRunning) {
      return;
    }

    const samples = event.inputBuffer.getChannelData(0);
    const frame = this.analyzeSamples(samples);
    const sampleRate = this.audioContext.sampleRate;
    const bufferDurationMs = (samples.length / sampleRate) * 1000;
    const bufferStartMs = Number.isFinite(event.playbackTime)
      ? this.contextPerfOffsetMs + event.playbackTime * 1000
      : performance.now() - bufferDurationMs;
    const onsetTimeMs = bufferStartMs + (frame.peakIndex / sampleRate) * 1000;

    const enoughTimePassed = onsetTimeMs - this.lastOnsetAtMs >= this.config.micMinIntervalMs;
    const transientWithoutLoudness = frame.onsetScore > frame.threshold * 1.35;
    const aboveGate = frame.energy >= this.config.noiseGate || transientWithoutLoudness;

    if (aboveGate && enoughTimePassed && frame.onsetScore > frame.threshold) {
      this.lastOnsetAtMs = onsetTimeMs;
      this.onOnset({
        timeMs: onsetTimeMs,
        energy: frame.energy,
        threshold: frame.threshold,
        onsetScore: frame.onsetScore,
        flux: frame.flux
      });
    }
  }

  analyzeSamples(samples) {
    let sumSquares = 0;
    let transientSum = 0;
    let peakIndex = 0;
    let peakTransient = 0;
    let previousSample = this.previousSample;

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const transient = Math.abs(sample - previousSample);
      sumSquares += sample * sample;
      transientSum += transient;

      if (transient > peakTransient) {
        peakTransient = transient;
        peakIndex = index;
      }

      previousSample = sample;
    }

    const energy = Math.sqrt(sumSquares / samples.length);
    const energyRise = Math.max(0, energy - this.previousRms);
    const flux = transientSum / samples.length;
    const onsetScore = flux * 0.72 + energyRise * 0.28;

    this.averageScore = this.averageScore * 0.94 + onsetScore * 0.06;
    const threshold = Math.max(
      0.0035 + (1 - this.config.sensitivity) * 0.018,
      this.averageScore * (2.1 - this.config.sensitivity) + this.config.noiseGate * 0.08
    );

    this.previousRms = energy;
    this.previousSample = previousSample;

    return {
      energy: round(energy, 5),
      threshold: round(threshold, 5),
      flux: round(flux, 5),
      onsetScore: round(onsetScore, 5),
      peakIndex
    };
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
