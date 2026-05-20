import { APP_CONFIG } from "./config.js";

const PROCESSOR_BUFFER_SIZE = 1024;
const FALLBACK_POLL_GRACE_MS = 180;

export class MicrophoneOnsetDetector {
  constructor({ onOnset = () => {}, onLevel = () => {}, onDebug = () => {} } = {}) {
    this.onOnset = onOnset;
    this.onLevel = onLevel;
    this.onDebug = onDebug;
    this.config = { ...APP_CONFIG.input };
    this.isRunning = false;
    this.lastOnsetAtMs = 0;
    this.previousRms = 0;
    this.previousSample = 0;
    this.averageScore = 0;
    this.lastProcessAtMs = 0;
    this.fallbackRafId = null;
  }

  async start() {
    if (this.isRunning) {
      await this.prime();
      return;
    }

    await this.prime();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    await this.prime();

    this.contextPerfOffsetMs = performance.now() - this.audioContext.currentTime * 1000;
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.processor = this.audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = PROCESSOR_BUFFER_SIZE;
    this.analyserSamples = new Float32Array(this.analyser.fftSize);
    this.analyserByteSamples = new Uint8Array(this.analyser.fftSize);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0.000001;

    this.processor.onaudioprocess = (event) => this.processAudio(event);
    this.lastProcessAtMs = 0;
    this.source.connect(this.processor);
    this.source.connect(this.analyser);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);

    this.isRunning = true;
    this.startFallbackPolling();
  }

  async prime() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("Web Audio API unavailable");
    }

    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContextClass();
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
  }

  stop() {
    this.isRunning = false;
    cancelAnimationFrame(this.fallbackRafId);
    this.fallbackRafId = null;

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
    this.analyser = null;
    this.analyserSamples = null;
    this.analyserByteSamples = null;
    this.silentGain = null;
  }

  setSensitivity(value) {
    this.config.sensitivity = clamp(Number(value) || APP_CONFIG.input.sensitivity, 0.2, 0.95);
  }

  processAudio(event) {
    if (!this.isRunning) {
      return;
    }

    this.lastProcessAtMs = performance.now();
    const samples = event.inputBuffer.getChannelData(0);
    const frame = this.analyzeSamples(samples);
    const sampleRate = this.audioContext.sampleRate;
    const bufferDurationMs = (samples.length / sampleRate) * 1000;
    const bufferStartMs = Number.isFinite(event.playbackTime)
      ? this.contextPerfOffsetMs + event.playbackTime * 1000
      : performance.now() - bufferDurationMs;
    const onsetTimeMs = bufferStartMs + (frame.peakIndex / sampleRate) * 1000;

    this.handleFrame(frame, onsetTimeMs);
  }

  handleFrame(frame, onsetTimeMs) {
    this.onLevel(frame);
    this.onDebug(frame);

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

  startFallbackPolling() {
    const poll = () => {
      if (!this.isRunning) {
        return;
      }

      const now = performance.now();
      if (this.analyser && now - this.lastProcessAtMs > FALLBACK_POLL_GRACE_MS) {
        this.readAnalyserSamples();
        const frame = this.analyzeSamples(this.analyserSamples);
        this.handleFrame(frame, now);
      }

      this.fallbackRafId = requestAnimationFrame(poll);
    };

    this.fallbackRafId = requestAnimationFrame(poll);
  }

  readAnalyserSamples() {
    if (typeof this.analyser.getFloatTimeDomainData === "function") {
      this.analyser.getFloatTimeDomainData(this.analyserSamples);
      return;
    }

    this.analyser.getByteTimeDomainData(this.analyserByteSamples);
    for (let index = 0; index < this.analyserByteSamples.length; index += 1) {
      this.analyserSamples[index] = (this.analyserByteSamples[index] - 128) / 128;
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
