export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
