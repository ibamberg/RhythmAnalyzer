const METER_CONFIGS = {
  "4/4": {
    id: "4/4",
    label: "4/4",
    unitsPerPass: 4,
    unitName: "quarter",
    strongUnits: [0],
    defaultGrouping: [1, 1, 1, 1]
  },
  "6/8": {
    id: "6/8",
    label: "6/8",
    unitsPerPass: 6,
    unitName: "eighth",
    strongUnits: [0, 3],
    defaultGrouping: [3, 3]
  },
  "3/4": {
    id: "3/4",
    label: "3/4",
    unitsPerPass: 3,
    unitName: "quarter",
    strongUnits: [0],
    defaultGrouping: [1, 1, 1]
  },
  "2/4": {
    id: "2/4",
    label: "2/4",
    unitsPerPass: 2,
    unitName: "quarter",
    strongUnits: [0],
    defaultGrouping: [1, 1]
  },
  "9/8": {
    id: "9/8",
    label: "9/8",
    unitsPerPass: 9,
    unitName: "eighth",
    strongUnits: [0, 3, 6],
    defaultGrouping: [3, 3, 3]
  },
  "12/8": {
    id: "12/8",
    label: "12/8",
    unitsPerPass: 12,
    unitName: "eighth",
    strongUnits: [0, 3, 6, 9],
    defaultGrouping: [3, 3, 3, 3]
  }
};

// Возвращает описание размера по идентификатору вроде "4/4".
export function getMeterConfig(meterId) {
  const meter = METER_CONFIGS[meterId];
  if (!meter) {
    throw new Error(`Unknown meter: ${meterId}`);
  }
  return meter;
}

function getUnitDurationMs(meter, bpm) {
  const beatMs = 60000 / bpm;
  if (meter.unitName === "quarter") {
    return beatMs;
  }
  const groupSize = meter.defaultGrouping[0] || 3;
  return beatMs / groupSize;
}

// Один проход — полный такт выбранного размера; результат в миллисекундах.
export function getPassDurationMs(meter, bpm) {
  return getUnitDurationMs(meter, bpm) * meter.unitsPerPass;
}

// Границы групп внутри такта в единицах размера: 0..4 для 4/4, 0..6 для 6/8.
export function getBeatBoundaries(meter) {
  const boundaries = [0];
  let cursor = 0;

  for (const groupSize of meter.defaultGrouping) {
    cursor += groupSize;
    boundaries.push(cursor);
  }

  if (boundaries.at(-1) !== meter.unitsPerPass) {
    boundaries.push(meter.unitsPerPass);
  }

  return boundaries;
}

// Позиции кликов метронома внутри одного прохода, в единицах размера.
export function getMetronomeClickUnits(meter, clickMode) {
  if (clickMode === "eighth") {
    if (meter.unitName === "quarter") {
      return range(meter.unitsPerPass * 2).map((index) => index * 0.5);
    }
    return range(meter.unitsPerPass);
  }

  if (meter.unitName === "quarter") {
    return range(meter.unitsPerPass);
  }

  return [...meter.strongUnits];
}

export function isStrongPosition(meter, position) {
  return meter.strongUnits.some((strongPosition) => Math.abs(strongPosition - position) < 0.001);
}

function range(length) {
  return Array.from({ length }, (_, index) => index);
}
