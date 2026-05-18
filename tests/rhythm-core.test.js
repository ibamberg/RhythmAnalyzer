import assert from "node:assert/strict";
import { analyzeRhythm } from "../src/rhythm-core.js";

const tests = [];

test("empty input", () => {
  const result = analyzeRhythm({ meter: "4/4", passes: [] });
  assert.equal(result.status, "collecting");
  assert.equal(result.referencePass, null);
});

test("one pass only", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 500, 1000, 1500])]
  });
  assert.equal(result.status, "collecting");
  assert.equal(result.referencePass, null);
  assert.deepEqual(durations(result.passes[0]), ["quarter", "quarter", "quarter", "quarter"]);
});

test("straight eighths 4/4", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 250, 500, 750, 1000, 1250, 1500, 1750])]
  });
  assert.deepEqual(durations(result.passes[0]), Array(8).fill("eighth"));
});

test("straight quarters 4/4", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 500, 1000, 1500])]
  });
  assert.deepEqual(durations(result.passes[0]), Array(4).fill("quarter"));
});

test("sixteenths 4/4", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 125, 250, 375, 500])]
  });
  assert.deepEqual(durations(result.passes[0]).slice(0, 4), Array(4).fill("sixteenth"));
});

test("triplets 4/4", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 3000, [0, 250, 500, 750, 1000, 1250, 1500, 1750])]
  });
  assert.deepEqual(durations(result.passes[0]).slice(0, 7), Array(7).fill("eighthTriplet"));
  assert.ok(result.passes[0].elements.at(-1).value > 1);
});

test("uneven eighths", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 260, 505, 755, 1010, 1260, 1490, 1760])]
  });
  assert.deepEqual(durations(result.passes[0]), Array(8).fill("eighth"));
});

test("slightly early first hit", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [-40, 250, 500])]
  });
  assert.equal(result.passes[0].normalizedHits[0].quantizedPosition, 0);
});

test("duplicate hits", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 25, 250, 500])]
  });
  assert.deepEqual(result.passes[0].hitsMs, [0, 250, 500]);
});

test("6/8 eighths", () => {
  const result = analyzeRhythm({
    meter: "6/8",
    passes: [pass(1, 1800, [0, 300, 600, 900, 1200, 1500])]
  });
  assert.deepEqual(durations(result.passes[0]), Array(6).fill("eighth"));
});

test("6/8 strong grouping", () => {
  const result = analyzeRhythm({
    meter: "6/8",
    passes: [pass(1, 1800, [0, 900])]
  });
  assert.deepEqual(durations(result.passes[0]), ["dottedQuarter", "dottedQuarter"]);
});

test("compare repeated passes", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [
      pass(1, 2000, [0, 500, 1000, 1500]),
      pass(2, 2000, [0, 502, 1005, 1498])
    ]
  });
  assert.equal(result.status, "ready");
  assert.ok(result.confidence > 0.8);
});

test("compare noisy passes", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [
      pass(1, 2000, [0, 260, 505, 755, 1010, 1260, 1490, 1760]),
      pass(2, 2000, [0, 245, 520, 745, 995, 1240, 1515, 1745])
    ]
  });
  assert.equal(result.status, "ready");
  assert.ok(result.passes[1].similarityToReference >= 0.65);
});

test("different passes", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [
      pass(1, 2000, [0, 500, 1000, 1500]),
      pass(2, 2000, [0, 250, 500, 750, 1000, 1250, 1500, 1750])
    ]
  });
  assert.equal(result.status, "collecting");
  assert.ok(result.confidence < 0.65);
});

test("input is not mutated", () => {
  const inputPasses = [pass(1, 2000, [0, 25, 250, 500])];
  const snapshot = JSON.stringify(inputPasses);
  analyzeRhythm({ meter: "4/4", passes: inputPasses });
  assert.equal(JSON.stringify(inputPasses), snapshot);
});

test("several passes raise confidence", () => {
  const twoPasses = analyzeRhythm({
    meter: "4/4",
    passes: [
      pass(1, 2000, [0, 500, 1000, 1500]),
      pass(2, 2000, [0, 503, 1002, 1497])
    ]
  });

  const fourPasses = analyzeRhythm({
    meter: "4/4",
    passes: [
      pass(1, 2000, [0, 500, 1000, 1500]),
      pass(2, 2000, [0, 503, 1002, 1497]),
      pass(3, 2000, [0, 492, 1008, 1504]),
      pass(4, 2000, [0, 501, 998, 1502])
    ]
  });

  assert.equal(fourPasses.status, "ready");
  assert.ok(fourPasses.confidence > twoPasses.confidence);
});

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}

function test(name, fn) {
  tests.push({ name, fn });
}

function pass(index, durationMs, hitsMs) {
  return {
    index,
    startedAtMs: index * durationMs,
    durationMs,
    hitsMs
  };
}

function durations(analyzedPass) {
  return analyzedPass.elements.map((element) => element.duration);
}
