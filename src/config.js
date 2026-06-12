export const APP_CONFIG = {
  input: {
    earlyHitSnapMs: 90,
    startHitSnapMs: 90,
    duplicateHitMs: 55,
    micMinIntervalMs: 75,
    // Окно вокруг каждого слышимого клика, в котором онсеты с микрофона
    // считаются просачиванием метронома. Асимметричное: хвост клика и
    // задержка вывода/захвата звучат после запланированного времени.
    clickSuppressPreMs: 30,
    clickSuppressPostMs: 150,
    noiseGate: 0.025,
    sensitivity: 0.58
  },
  analysis: {
    minPassesForPattern: 2,
    maxStoredPasses: 32,
    hitToleranceMs: 90,
    adaptiveToleranceRatio: 0.12,
    minConfidenceForPattern: 0.65
  },
  calibration: {
    bpm: 90,
    taps: 8,
    maxOffsetMs: 250
  }
};
