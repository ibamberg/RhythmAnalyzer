import { APP_CONFIG } from "./config.js";
import { clamp } from "./utils.js";

export class MicrophoneOnsetDetector {
  constructor({ onOnset = () => {}, onSuppressedOnset = () => {} } = {}) {
    this.onOnset = onOnset;
    this.onSuppressedOnset = onSuppressedOnset;
    this.config = { ...APP_CONFIG.input };
    this.isRunning = false;
    this._startId = 0;
    this._workletReady = null;
  }

  // audioContext must be a shared, externally managed AudioContext.
  // echoCancellation: включаем браузерный AEC, когда метроном звучит из
  // динамиков — он вычитает собственное воспроизведение системы из микрофона.
  async start(audioContext, { echoCancellation = false } = {}) {
    if (this.isRunning) return;

    this._startId += 1;
    const startId = this._startId;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    if (this._startId !== startId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    this.stream = stream;
    this.audioContext = audioContext;

    if (!this._workletReady) {
      this._workletReady = audioContext.audioWorklet.addModule("./src/mic-processor.js");
    }
    await this._workletReady;

    if (this._startId !== startId) return;

    this.source = audioContext.createMediaStreamSource(this.stream);

    // Отвод для индикатора уровня: сырой сигнал до фильтров
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelBuffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);

    // Тракт микрофона: notch на частотах тонов клика (теперь это чистые
    // синусы — одна спектральная линия) + lowpass под шумовым всплеском
    // клика (>6 кГц). Вместе они убирают большую часть энергии клика,
    // не задевая хлопки и удары.
    this.notch1 = this._createNotch(audioContext, 1100);
    this.notch2 = this._createNotch(audioContext, 1800);
    this.lowpass = audioContext.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = 5000;

    this.workletNode = new AudioWorkletNode(audioContext, "microphone-onset-processor", {
      processorOptions: {
        sensitivity: this.config.sensitivity,
        noiseGate: this.config.noiseGate,
        micMinIntervalMs: this.config.micMinIntervalMs,
        clickSuppressPreMs: this.config.clickSuppressPreMs,
        clickSuppressPostMs: this.config.clickSuppressPostMs,
      }
    });

    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === "onset") {
        this.onOnset(event.data);
      } else if (event.data.type === "suppressed") {
        this.onSuppressedOnset(event.data);
      }
    };

    // Zero-gain output to keep the graph alive
    this.silentGain = audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.source.connect(this.notch1);
    this.notch1.connect(this.notch2);
    this.notch2.connect(this.lowpass);
    this.lowpass.connect(this.workletNode);
    this.workletNode.connect(this.silentGain);
    this.silentGain.connect(audioContext.destination);

    this.isRunning = true;
  }

  stop() {
    this._startId += 1;
    this.isRunning = false;

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }
    if (this.notch1) this.notch1.disconnect();
    if (this.notch2) this.notch2.disconnect();
    if (this.lowpass) this.lowpass.disconnect();
    if (this.analyser) this.analyser.disconnect();
    if (this.source) this.source.disconnect();
    if (this.silentGain) this.silentGain.disconnect();

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }

    this.stream = null;
    this.source = null;
    this.workletNode = null;
    this.notch1 = null;
    this.notch2 = null;
    this.lowpass = null;
    this.analyser = null;
    this.levelBuffer = null;
    this.silentGain = null;
    // audioContext is managed externally — do not close it here
    this.audioContext = null;
  }

  setSensitivity(value) {
    this.config.sensitivity = clamp(Number(value) || APP_CONFIG.input.sensitivity, 0.2, 0.95);
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "sensitivity", value: this.config.sensitivity });
    }
  }

  // Текущий RMS-уровень микрофона 0..1 (сырой сигнал, до фильтров).
  getLevel() {
    if (!this.isRunning || !this.analyser) {
      return 0;
    }

    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sumSquares = 0;
    for (let i = 0; i < this.levelBuffer.length; i += 1) {
      sumSquares += this.levelBuffer[i] * this.levelBuffer[i];
    }
    return Math.sqrt(sumSquares / this.levelBuffer.length);
  }

  // Сообщает worklet'у время (в секундах AudioContext) запланированного
  // слышимого клика — онсеты в окне вокруг него гейтятся как просачивание.
  noteClickScheduled(audioTime) {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: "click", time: audioTime });
    }
  }

  _createNotch(ctx, frequency) {
    const filter = ctx.createBiquadFilter();
    filter.type = "notch";
    filter.frequency.value = frequency;
    filter.Q.value = 8;
    return filter;
  }
}
