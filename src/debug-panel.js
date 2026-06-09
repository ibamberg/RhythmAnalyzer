import { APP_CONFIG } from "./config.js";

export function renderDebugPanel(container, passes, analyzeResult) {
  const analyzedByIndex = new Map(analyzeResult.passes.map((pass) => [pass.index, pass]));
  const recordedPasses = passes
    .filter((pass) => Array.isArray(pass.hitsMs) && pass.hitsMs.length > 0)
    .slice(-APP_CONFIG.analysis.maxStoredPasses);
  const referencePass = getReferencePass(recordedPasses, analyzedByIndex, analyzeResult);

  container.innerHTML = `
    ${renderSummary(analyzeResult, recordedPasses.length, referencePass)}
    ${renderDebugMatrix(recordedPasses, analyzedByIndex, referencePass)}
  `;

  const matrixWrap = container.querySelector(".debug-matrix-wrap");
  if (matrixWrap) {
    matrixWrap.scrollTop = matrixWrap.scrollHeight;
  }
}

function renderSummary(result, passCount, referencePass) {
  return `
    <section class="debug-panel__summary">
      <div class="debug-summary-row">
        status ${escapeHtml(result.status)}
        <span>|</span>
        confidence ${formatConfidence(result.confidence)}
        <span>|</span>
        passes ${passCount}
        <span>|</span>
        ref ${referencePass ? referencePass.index : "--"}
        <span>|</span>
        ${escapeHtml(result.message)}
      </div>
    </section>
  `;
}

export function renderDebugMatrix(passes, analyzedByIndex = new Map(), referencePass = null) {
  if (!passes.length) {
    return `
      <div class="debug-empty">
        No recorded hits yet
      </div>
    `;
  }

  const rows = passes.map((pass) => ({
    pass,
    analyzedPass: analyzedByIndex.get(pass.index),
    hitsMs: analyzedByIndex.get(pass.index)?.hitsMs || pass.hitsMs
  }));
  const maxHits = Math.max(...rows.map((row) => row.hitsMs.length), 0);

  const headerCells = Array.from({ length: maxHits }, (_, index) => `<th>hit ${index + 1}</th>`)
    .join("");
  const bodyRows = rows
    .map((row) => renderMatrixRow(row, maxHits, referencePass))
    .join("");

  return `
    <div class="debug-matrix-wrap">
      <table class="debug-matrix">
        <thead>
          <tr>
            <th class="debug-matrix__pass">pass</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
  `;
}

function renderMatrixRow({ pass, analyzedPass, hitsMs }, maxHits, referencePass) {
  const similarity = analyzedPass?.similarityToReference;
  const confidence = analyzedPass?.confidence;
  const isReference = referencePass?.index === pass.index;
  const hasWarning =
    similarity !== null &&
    similarity !== undefined &&
    similarity < APP_CONFIG.analysis.minConfidenceForPattern;
  const title = [
    `pass ${pass.index}`,
    isReference ? "reference" : "",
    similarity === null || similarity === undefined ? "similarity --" : `similarity ${formatConfidence(similarity)}`,
    confidence === undefined ? "" : `confidence ${formatConfidence(confidence)}`
  ].filter(Boolean);

  return `
    <tr class="${hasWarning ? "is-warning" : ""} ${isReference ? "is-reference" : ""}" title="${escapeHtml(title.join(" | "))}">
      <th class="debug-matrix__pass">${pass.index}</th>
      ${Array.from({ length: maxHits }, (_, index) => renderHitCell(hitsMs[index], referencePass, index, isReference)).join("")}
    </tr>
  `;
}

function renderHitCell(hitMs, referencePass, hitIndex, isReference) {
  if (!Number.isFinite(hitMs)) {
    return "<td></td>";
  }

  const referenceHitMs = referencePass?.hitsMs?.[hitIndex];
  const shouldShowDelta = !isReference && Number.isFinite(referenceHitMs);
  const delta = shouldShowDelta ? hitMs - referenceHitMs : null;

  return `
    <td>
      <span class="debug-hit-value">${formatMs(hitMs)}</span>
      ${shouldShowDelta ? `<span class="debug-hit-delta ${getDeltaClass(delta)}">${formatDelta(delta)}</span>` : ""}
    </td>
  `;
}

function getReferencePass(passes, analyzedByIndex, analyzeResult) {
  if (analyzeResult.referencePass?.hitsMs?.length) {
    return {
      index: analyzeResult.referencePass.index,
      hitsMs: analyzeResult.referencePass.hitsMs
    };
  }

  const firstPass = passes.find((pass) => pass.hitsMs.length > 0);
  if (!firstPass) {
    return null;
  }

  const analyzedFirstPass = analyzedByIndex.get(firstPass.index);
  return {
    index: firstPass.index,
    hitsMs: analyzedFirstPass?.hitsMs || firstPass.hitsMs
  };
}

function getDeltaClass(delta) {
  const absDelta = Math.abs(delta);
  if (absDelta <= 20) {
    return "debug-delta--ok";
  }
  if (absDelta <= 60) {
    return "debug-delta--warn";
  }
  return "debug-delta--bad";
}

function formatConfidence(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function formatMs(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "";
}

function formatDelta(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Math.abs(value) < 0.05) {
    return "&plusmn;0.0";
  }
  const rounded = value.toFixed(1);
  return value > 0 ? `+${rounded}` : rounded;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
