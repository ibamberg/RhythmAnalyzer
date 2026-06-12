// AudioWorklet processor — runs in the audio rendering thread.
// No ES module imports available here; utilities are inlined.

// Equivalent to 0.94 per 1024-sample buffer: 0.94^(128/1024)
const DECAY_PER_QUANTUM = 0.9923;

class MicrophoneOnsetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.previousRms = 0;
    this.previousSample = 0;
    this.averageScore = 0;
    this.lastOnsetAtTime = -1;
    // AudioContext times (seconds) of audible metronome clicks, sent ahead of
    // playback by the main thread. Onsets inside a click window are bleed.
    this.clickTimes = [];

    const opts = (options && options.processorOptions) || {};
    this.sensitivity = opts.sensitivity != null ? opts.sensitivity : 0.58;
    this.noiseGate = opts.noiseGate != null ? opts.noiseGate : 0.025;
    this.micMinIntervalSec = (opts.micMinIntervalMs != null ? opts.micMinIntervalMs : 75) / 1000;
    this.suppressPreSec = (opts.clickSuppressPreMs != null ? opts.clickSuppressPreMs : 30) / 1000;
    this.suppressPostSec = (opts.clickSuppressPostMs != null ? opts.clickSuppressPostMs : 150) / 1000;

    this.port.onmessage = (event) => {
      if (event.data.type === "sensitivity") this.sensitivity = event.data.value;
      if (event.data.type === "click") this.clickTimes.push(event.data.time);
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;

    const frame = this.analyzeSamples(channel);
    // currentTime is the start of this render quantum in AudioContext seconds
    const onsetAudioTime = currentTime + frame.peakIndex / sampleRate;
    const inClickWindow = this.isNearClick(onsetAudioTime);

    // Click bleed must not skew the adaptive threshold
    if (!inClickWindow) {
      this.averageScore = this.averageScore * DECAY_PER_QUANTUM + frame.onsetScore * (1 - DECAY_PER_QUANTUM);
    }

    const threshold = Math.max(
      0.0035 + (1 - this.sensitivity) * 0.018,
      this.averageScore * (2.1 - this.sensitivity) + this.noiseGate * 0.08
    );

    const enoughTimePassed = onsetAudioTime - this.lastOnsetAtTime >= this.micMinIntervalSec;
    const transientWithoutLoudness = frame.onsetScore > threshold * 1.35;
    const aboveGate = frame.energy >= this.noiseGate || transientWithoutLoudness;

    if (aboveGate && enoughTimePassed && frame.onsetScore > threshold) {
      // Inside a click window only an onset clearly stronger than the click
      // residue passes through as a real user hit.
      const strongOnset =
        frame.onsetScore > threshold * 1.8 && frame.energy > this.noiseGate * 2.2;

      if (inClickWindow && !strongOnset) {
        this.port.postMessage({ type: "suppressed", audioTime: onsetAudioTime });
      } else {
        this.lastOnsetAtTime = onsetAudioTime;
        this.port.postMessage({
          type: "onset",
          audioTime: onsetAudioTime,
          energy: frame.energy,
          threshold,
          onsetScore: frame.onsetScore,
          flux: frame.flux,
        });
      }
    }

    return true;
  }

  isNearClick(time) {
    while (this.clickTimes.length && this.clickTimes[0] < time - 1) {
      this.clickTimes.shift();
    }
    return this.clickTimes.some(
      (click) => time >= click - this.suppressPreSec && time <= click + this.suppressPostSec
    );
  }

  analyzeSamples(samples) {
    let sumSquares = 0;
    let transientSum = 0;
    let peakIndex = 0;
    let peakTransient = 0;
    let previousSample = this.previousSample;

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const transient = Math.abs(sample - previousSample);
      sumSquares += sample * sample;
      transientSum += transient;
      if (transient > peakTransient) {
        peakTransient = transient;
        peakIndex = i;
      }
      previousSample = sample;
    }

    const energy = Math.sqrt(sumSquares / samples.length);
    const energyRise = Math.max(0, energy - this.previousRms);
    const flux = transientSum / samples.length;
    const onsetScore = flux * 0.72 + energyRise * 0.28;

    this.previousRms = energy;
    this.previousSample = previousSample;

    return { energy, flux, onsetScore, peakIndex };
  }
}

registerProcessor("microphone-onset-processor", MicrophoneOnsetProcessor);
