export const APP_CONFIG = {
  input: {
    earlyHitSnapMs: 90,
    startHitSnapMs: 90,
    duplicateHitMs: 55,
    micMinIntervalMs: 75,
    metronomeClickSuppressMs: 45,
    noiseGate: 0.025,
    sensitivity: 0.58
  },
  analysis: {
    minPassesForPattern: 2,
    maxStoredPasses: 32,
    hitToleranceMs: 90,
    adaptiveToleranceRatio: 0.12,
    minConfidenceForPattern: 0.65
  }
};
