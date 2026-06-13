import assert from "node:assert/strict";
import { classifyDuration } from "../src/durations.js";
import { getMeterConfig, getPassDurationMs } from "../src/meter.js";
import { positionFromHitMs, sanitizeHits } from "../src/pass-utils.js";
import { analyzePass, analyzeRhythm, comparePasses } from "../src/rhythm-core.js";

const tests = [];

test("getPassDurationMs for 4/4 and 6/8", () => {
  assert.equal(getPassDurationMs(getMeterConfig("4/4"), 120), 2000);
  assert.equal(getPassDurationMs(getMeterConfig("6/8"), 120), 1000);
});

test("sanitizeHits snaps early hits, removes duplicates, and drops out-of-pass hits", () => {
  const hits = [-200, -40, 0, 25, 250, 2100];
  assert.deepEqual(sanitizeHits(hits, 2000), [0, 250]);
  assert.deepEqual(hits, [-200, -40, 0, 25, 250, 2100]);
});

test("positionFromHitMs converts milliseconds to meter positions", () => {
  assert.equal(positionFromHitMs(500, 2000, getMeterConfig("4/4")), 1);
  assert.equal(positionFromHitMs(300, 1800, getMeterConfig("6/8")), 1);
});

test("classifyDuration for 4/4 and 6/8", () => {
  const fourFour = getMeterConfig("4/4");
  const sixEight = getMeterConfig("6/8");

  assert.equal(classifyDuration(1, fourFour).duration, "quarter");
  assert.equal(classifyDuration(0.5, fourFour).duration, "eighth");
  assert.equal(classifyDuration(1 / 3, fourFour).duration, "eighthTriplet");
  assert.equal(classifyDuration(1, sixEight).duration, "eighth");
  assert.equal(classifyDuration(3, sixEight).duration, "dottedQuarter");
});

test("analyzePass straight quarters", () => {
  const analyzed = analyzePass(pass(1, 2000, [0, 500, 1000, 1500]), getMeterConfig("4/4"));
  assert.deepEqual(durations(analyzed), Array(4).fill("quarter"));
});

test("analyzePass straight eighths", () => {
  const analyzed = analyzePass(
    pass(1, 2000, [0, 250, 500, 750, 1000, 1250, 1500, 1750]),
    getMeterConfig("4/4")
  );
  assert.deepEqual(durations(analyzed), Array(8).fill("eighth"));
});

test("analyzePass triplets in 4/4", () => {
  const analyzed = analyzePass(
    pass(1, 3000, [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750]),
    getMeterConfig("4/4")
  );
  assert.deepEqual(durations(analyzed), Array(12).fill("eighthTriplet"));
});

test("analyzePass accepts uneven hits inside tolerance", () => {
  const analyzed = analyzePass(
    pass(1, 2000, [0, 260, 505, 755, 1010, 1260, 1490, 1760]),
    getMeterConfig("4/4")
  );
  assert.deepEqual(durations(analyzed), Array(8).fill("eighth"));
});

test("comparePasses direct similarity", () => {
  const meter = getMeterConfig("4/4");
  const reference = analyzePass(pass(1, 2000, [0, 500, 1000, 1500]), meter);
  const similar = analyzePass(pass(2, 2000, [0, 502, 1005, 1498]), meter);
  const different = analyzePass(pass(3, 2000, [0, 250, 500, 750, 1000, 1250, 1500, 1750]), meter);

  assert.ok(comparePasses(reference, similar, 0.12) > 0.9);
  assert.ok(comparePasses(reference, different, 0.12) < 0.65);
});

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
    passes: [
      pass(1, 3000, [
        0,
        250,
        500,
        750,
        1000,
        1250,
        1500,
        1750,
        2000,
        2250,
        2500,
        2750
      ])
    ]
  });
  assert.deepEqual(durations(result.passes[0]), Array(12).fill("eighthTriplet"));
});

test("mixed triplet spelling 4/4", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2400, [0, 600, 1200, 1400, 1500, 1800, 2100, 2250])]
  });
  assert.deepEqual(durations(result.passes[0]), [
    "quarter",
    "quarter",
    "eighthTriplet",
    "sixteenthTriplet",
    "dottedEighthTriplet",
    "eighth",
    "sixteenth",
    "sixteenth"
  ]);
});

test("no mixed binary/ternary grid within one beat", () => {
  // 340 мс при доле 500 мс раньше квантизовался на триольную точку 2/3
  // между бинарными соседями — получались невозможные комбинации
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 125, 250, 340, 500, 1000, 1500])]
  });
  assert.deepEqual(
    durations(result.passes[0]).slice(0, 4),
    ["sixteenth", "sixteenth", "sixteenth", "sixteenth"]
  );
});

test("stray offbeat hit does not switch the beat to ternary grid", () => {
  // Удар на 0.82 доли — неточная «и» (0.75), а не секстоль 5/6:
  // без удара возле 1/3 или 2/3 доля остаётся бинарной
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2400, [0, 493, 1071, 1671])]
  });
  assert.deepEqual(durations(result.passes[0]), [
    "dottedEighth",
    "sixteenth",
    "sixteenth",
    "sixteenth"
  ]);
});

test("swing pair is written binary, not as a lone triplet", () => {
  // Два удара в долю (0 и 2/3) — это свинг, но без третьей ноты триолью
  // не пишем: бинарная сетка, пунктир, без скобки «3».
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 333, 500, 833])]
  });
  const durs = durations(result.passes[0]);
  assert.ok(!durs.some((duration) => duration.includes("Triplet")), durs.join(","));
  assert.deepEqual(durs, ["dottedEighth", "sixteenth", "dottedEighth", "sixteenth"]);
});

test("three notes in one beat are spelled as a triplet", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 4000, [0, 333, 667, 1000])]
  });
  assert.deepEqual(durations(result.passes[0]).slice(0, 3), [
    "eighthTriplet",
    "eighthTriplet",
    "eighthTriplet"
  ]);
});

test("dense near-even tapping does not get spurious triplets", () => {
  // ~4 равномерных удара на долю с шагом ~0.28 чуть лучше ложатся на
  // триольную сетку, но не настолько, чтобы заслужить скобку «3»
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2400, [0, 152, 323, 502, 683, 862, 1043, 1243])]
  });
  const durs = durations(result.passes[0]);
  assert.ok(!durs.some((duration) => duration.includes("Triplet")), durs.join(","));
});

test("analysis windows stop at beat boundaries", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 250, 500])]
  });
  assert.deepEqual(durations(result.passes[0]), ["eighth", "eighth", "quarter"]);
  assert.equal(result.passes[0].elements[1].toPosition, 1);
});

test("slightly early boundary hit belongs to next window", () => {
  const result = analyzeRhythm({
    meter: "4/4",
    passes: [pass(1, 2000, [0, 480, 1000, 1500])]
  });
  assert.deepEqual(durations(result.passes[0]), ["quarter", "quarter", "quarter", "quarter"]);
  assert.equal(result.passes[0].normalizedHits[1].quantizedPosition, 1);
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
