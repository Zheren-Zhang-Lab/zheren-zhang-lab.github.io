export const RAW_MEASUREMENT_FIELDS = [
  "experiment_id", "measurement_id", "measurement_type", "wavelength_nm", "unit",
  "elapsed_seconds", "time_h", "time_original", "well", "well_original",
  "plate_row", "plate_column", "content_original", "value_raw", "qc_flag"
];

const WELL_PATTERN = /^\s*([A-Za-z])\s*0*([1-9]|1\d|2[0-4])\s*$/;

function text(value) {
  return value == null ? "" : String(value).trim();
}

export function normalizeWell(value) {
  const match = text(value).match(WELL_PATTERN);
  if (!match) return null;
  return `${match[1].toUpperCase()}${Number(match[2])}`;
}

export function parseElapsedTime(value) {
  const original = text(value);
  if (!original) return null;
  if (/^\d+(?:\.\d+)?$/.test(original)) {
    const seconds = Number(original);
    return { original, seconds, hours: seconds / 3600 };
  }
  const units = { d: 86400, day: 86400, days: 86400, h: 3600, hr: 3600, hrs: 3600,
    hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
  let seconds = 0;
  let matches = 0;
  for (const match of original.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/g)) {
    seconds += Number(match[1]) * units[match[2]];
    matches += 1;
  }
  if (!matches) return null;
  return { original, seconds, hours: seconds / 3600 };
}

function findHeader(matrix) {
  let best = null;
  matrix.forEach((row, rowIndex) => {
    const normalized = row.map(cell => text(cell).toLowerCase());
    const wellIndex = normalized.findIndex(cell => cell === "well");
    const contentIndex = normalized.findIndex(cell => cell === "content");
    const measurementIndexes = normalized
      .map((cell, index) => /raw\s*data|measurement|absorbance|fluorescence|luminescence/.test(cell) ? index : -1)
      .filter(index => index >= 0);
    const score = (wellIndex >= 0 ? 2 : 0) + (contentIndex >= 0 ? 1 : 0) + (measurementIndexes.length ? 2 : 0);
    if (!best || score > best.score) best = { rowIndex, wellIndex, contentIndex, measurementIndexes, score };
  });
  return best && best.score >= 4 ? best : null;
}

function findTimeRow(matrix, header) {
  const start = header.rowIndex + 1;
  const end = Math.min(matrix.length, start + 8);
  let best = null;
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const parsed = row.map(parseElapsedTime);
    const parseable = parsed.filter(Boolean).length;
    const hasTimeLabel = row.some(cell => text(cell).toLowerCase() === "time");
    const score = parseable + (hasTimeLabel ? 3 : 0);
    if (!best || score > best.score) best = { rowIndex, parsed, score, hasTimeLabel };
  }
  return best && best.parsed.filter(Boolean).length >= 2 ? best : null;
}

function metadataFrom(matrix, endRow) {
  const metadata = {};
  matrix.slice(0, endRow).flat().forEach(cell => {
    const value = text(cell);
    const match = value.match(/^([^:]{2,30}):\s*(.+)$/);
    if (match) metadata[match[1].trim().toLowerCase()] = match[2].trim();
  });
  return metadata;
}

function inferMeasurement(matrix, header) {
  const rowText = (matrix[header.rowIndex] || []).map(text).join(" ");
  const context = matrix.slice(Math.max(0, header.rowIndex - 6), header.rowIndex + 1).flat().map(text).join(" ");
  const wavelengthMatch = rowText.match(/(?:raw\s*data|absorbance)?\s*\(?\s*(\d{3,4})\s*(?:nm)?\s*\)?/i) || context.match(/(\d{3,4})\s*nm/i);
  const wavelength = wavelengthMatch ? Number(wavelengthMatch[1]) : null;
  let measurementType = "unknown";
  if (/absorbance|\babs\b|\bod\d*/i.test(context)) measurementType = "absorbance";
  else if (/fluorescence/i.test(context)) measurementType = "fluorescence";
  else if (/luminescence/i.test(context)) measurementType = "luminescence";
  const unit = /displayed as od|\bod\b/i.test(context) ? "OD" : "unknown";
  return {
    measurementType,
    wavelength,
    unit,
    measurementId: `${measurementType === "unknown" ? "measurement" : measurementType.slice(0, 3)}_${wavelength || "unknown"}`
  };
}

function collectWells(matrix, startRow, wellIndex) {
  const wells = [];
  for (let rowIndex = startRow; rowIndex < matrix.length; rowIndex += 1) {
    const original = text(matrix[rowIndex]?.[wellIndex]);
    const normalized = normalizeWell(original);
    if (normalized) wells.push({ rowIndex, original, normalized });
  }
  return wells;
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const valueText = text(value);
  return valueText !== "" && Number.isFinite(Number(valueText)) ? Number(valueText) : null;
}

function supportedPlateWell(value) {
  const well = normalizeWell(value);
  return well && well.charCodeAt(0) <= 80 ? well : null;
}

function findMarker(matrix, pattern) {
  const matches = [];
  matrix.forEach((row, rowIndex) => (row || []).forEach((cell, columnIndex) => {
    if (pattern.test(text(cell))) matches.push({ rowIndex, columnIndex, original: text(cell) });
  }));
  return matches;
}

function tecanMetadataFrom(matrix, endRow) {
  const metadata = {};
  matrix.slice(0, endRow).forEach(row => {
    const entries = (row || []).map((value, columnIndex) => ({ value: text(value), columnIndex })).filter(entry => entry.value);
    if (!entries.length) return;
    const first = entries[0].value;
    const inline = first.match(/^([^:]{2,50}):\s*(.+)$/);
    if (inline) {
      metadata[inline[1].trim().toLowerCase()] = inline[2].trim();
      return;
    }
    const key = first.replace(/:\s*$/, "").trim().toLowerCase();
    if (key && entries.length > 1) metadata[key] = entries.slice(1).map(entry => entry.value).join(" ");
  });
  return metadata;
}

function findTecanRegion(matrix) {
  const cycleCandidates = findMarker(matrix, /^cycle\s*(?:nr\.?|number)$/i);
  const timeCandidates = findMarker(matrix, /^time\s*(?:\[\s*(?:s|sec(?:onds?)?)\s*\]|\(\s*(?:s|sec(?:onds?)?)\s*\))$/i);
  let best = null;
  cycleCandidates.forEach(cycle => timeCandidates.forEach(time => {
    const rowDistance = Math.abs(time.rowIndex - cycle.rowIndex);
    if (rowDistance > 8) return;
    const timeRow = matrix[time.rowIndex] || [];
    const cycleRow = matrix[cycle.rowIndex] || [];
    const startColumn = Math.max(cycle.columnIndex, time.columnIndex) + 1;
    const timeColumns = [];
    for (let columnIndex = startColumn; columnIndex < timeRow.length; columnIndex += 1) {
      const seconds = numericValue(timeRow[columnIndex]);
      if (seconds == null) {
        if (timeColumns.length) break;
        continue;
      }
      timeColumns.push({
        columnIndex,
        seconds,
        hours: seconds / 3600,
        original: text(timeRow[columnIndex]),
        cycle: numericValue(cycleRow[columnIndex])
      });
    }
    const monotonic = timeColumns.every((entry, index) => index === 0 || entry.seconds > timeColumns[index - 1].seconds);
    const cycleMatches = timeColumns.filter(entry => entry.cycle != null).length;
    const score = timeColumns.length + cycleMatches * 0.25 - rowDistance;
    if (monotonic && timeColumns.length >= 2 && (!best || score > best.score)) {
      best = { cycle, time, timeColumns, score };
    }
  }));
  return best;
}

function collectTecanWells(matrix, region) {
  const wells = [];
  const seen = new Set();
  for (let rowIndex = region.time.rowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    if (row.some(cell => /^cycle\s*(?:nr\.?|number)$/i.test(text(cell)))) break;
    let wellInfo = null;
    for (let columnIndex = 0; columnIndex < Math.min(row.length, region.timeColumns[0].columnIndex); columnIndex += 1) {
      const normalized = supportedPlateWell(row[columnIndex]);
      if (normalized) {
        wellInfo = { rowIndex, columnIndex, original: text(row[columnIndex]), normalized };
        break;
      }
    }
    if (!wellInfo) continue;
    const numericCount = region.timeColumns.filter(time => numericValue(row[time.columnIndex]) != null).length;
    if (numericCount < Math.min(2, region.timeColumns.length)) continue;
    if (seen.has(wellInfo.normalized)) return { wells: [], duplicateWell: wellInfo.normalized };
    seen.add(wellInfo.normalized);
    wells.push(wellInfo);
  }
  return { wells, duplicateWell: null };
}

function inferPlateDetails(wells, metadataPlateText = "") {
  const rows = wells.map(well => well.normalized.charCodeAt(0) - 64);
  const columns = wells.map(well => Number(well.normalized.slice(1)));
  const maxRow = Math.max(...rows);
  const maxColumn = Math.max(...columns);
  const inferredPlateWells = maxRow <= 4 && maxColumn <= 6 ? 24 : maxRow <= 6 && maxColumn <= 8 ? 48 : maxRow <= 8 && maxColumn <= 12 ? 96 : 384;
  const metadataMatch = text(metadataPlateText).match(/\b(24|48|96|384)\b/i);
  const metadataPlateWells = metadataMatch ? Number(metadataMatch[1]) : null;
  const fits = size => (size === 24 && maxRow <= 4 && maxColumn <= 6) ||
    (size === 48 && maxRow <= 6 && maxColumn <= 8) ||
    (size === 96 && maxRow <= 8 && maxColumn <= 12) ||
    (size === 384 && maxRow <= 16 && maxColumn <= 24);
  const plateWells = metadataPlateWells && fits(metadataPlateWells) ? metadataPlateWells : inferredPlateWells;
  return { plateWells, plateSizeSource: metadataPlateWells === plateWells ? "metadata" : "inferred" };
}

function inferTecanMeasurement(matrix, region) {
  const contextRows = matrix.slice(0, region.cycle.rowIndex);
  const context = contextRows.flat().map(text).filter(Boolean).join(" ");
  const wavelengthRow = contextRows.find(row => (row || []).some(cell => /measurement\s*wavelength|wavelength/i.test(text(cell))));
  const wavelengthCell = wavelengthRow?.find(cell => {
    const value = numericValue(cell);
    return value != null && value >= 200 && value <= 1000;
  });
  const contextMatch = context.match(/(?:measurement\s*)?wavelength[^\d]{0,30}(\d{3,4})\s*(?:nm)?/i);
  const wavelength = numericValue(wavelengthCell) ?? (contextMatch ? Number(contextMatch[1]) : null);
  let measurementType = "unknown";
  if (/\babsorbance\b|\bod\s*\d*/i.test(context)) measurementType = "absorbance";
  else if (/\bfluorescence\b/i.test(context)) measurementType = "fluorescence";
  else if (/\bluminescence\b/i.test(context)) measurementType = "luminescence";
  return {
    measurementType,
    wavelength,
    unit: measurementType === "absorbance" ? "OD" : "unknown",
    measurementId: `${measurementType === "unknown" ? "measurement" : measurementType.slice(0, 3)}_${wavelength || "unknown"}`
  };
}

export function detectTecan(matrix, workbookMeta = {}) {
  const region = findTecanRegion(matrix);
  if (!region) return { format: "unknown", confidence: 0, confidenceLabel: "low", reasons: ["No aligned Cycle Nr. and Time [s] kinetic region found"] };
  const metadata = tecanMetadataFrom(matrix, region.cycle.rowIndex);
  const wellResult = collectTecanWells(matrix, region);
  const wells = wellResult.wells;
  const context = matrix.slice(0, region.cycle.rowIndex).flat().map(text).filter(Boolean).join(" ");
  const creator = text(workbookMeta.creator);
  const hasTecan = /\btecan\b/i.test(context) || /\btecan\b/i.test(creator);
  const hasIControl = /i[\s-]*control/i.test(context);
  const hasDevice = /\bdevice\b|infinite\s*\d+/i.test(context);
  const hasKinetic = /kinetic\s*(?:measurement|cycles?)|\bkinetic\b/i.test(context);
  const hasAbsorbance = /\babsorbance\b/i.test(context);
  const measurement = inferTecanMeasurement(matrix, region);
  let confidence = 0.32;
  const reasons = ["Found aligned Cycle Nr. and Time [s] rows"];
  if (region.timeColumns.length >= 2) { confidence += 0.15; reasons.push(`Found ${region.timeColumns.length} actual elapsed-time values`); }
  if (wells.length >= 2) { confidence += 0.2; reasons.push(`Found ${wells.length} valid plate-well measurement rows`); }
  if (hasIControl) { confidence += 0.12; reasons.push("Found Tecan i-control application metadata"); }
  if (hasTecan) { confidence += 0.08; reasons.push("Found Tecan instrument metadata"); }
  if (hasDevice) { confidence += 0.04; reasons.push("Found device metadata"); }
  if (hasKinetic && hasAbsorbance) { confidence += 0.04; reasons.push("Found kinetic absorbance metadata"); }
  if (measurement.wavelength) { confidence += 0.05; reasons.push(`Found measurement wavelength ${measurement.wavelength} nm`); }
  if (wellResult.duplicateWell) reasons.push(`Duplicate well row ${wellResult.duplicateWell} makes the kinetic region ambiguous`);
  confidence = Math.min(0.99, confidence);
  const supported = confidence >= 0.65 && wells.length >= 2 && !wellResult.duplicateWell;
  return {
    format: supported ? "tecan" : "unknown",
    confidence,
    confidenceLabel: confidence >= 0.85 ? "high" : confidence >= 0.65 ? "medium" : "low",
    reasons,
    region,
    metadata,
    wells,
    measurement
  };
}

export function parseTecan(matrix, workbookMeta = {}, options = {}) {
  const detection = detectTecan(matrix, workbookMeta);
  if (detection.format !== "tecan") throw new Error("This worksheet could not be confidently parsed as a supported Tecan i-control kinetic export.");
  const { region, metadata, wells, measurement } = detection;
  if (measurement.measurementType !== "absorbance") throw new Error("The detected Tecan kinetic region is not a supported absorbance measurement.");
  if (!measurement.wavelength) throw new Error("The Tecan absorbance wavelength could not be identified confidently.");
  const experimentSource = metadata.label || metadata["start time"] || options.sheetName || "tecan";
  const experimentId = options.experimentId || `exp_${experimentSource}`.replace(/[^A-Za-z0-9_-]+/g, "_");
  const rawMeasurements = [];
  let missingMeasurements = 0;
  wells.forEach(wellInfo => {
    const row = matrix[wellInfo.rowIndex] || [];
    const wellMatch = wellInfo.normalized.match(/^([A-Z])(\d+)$/);
    region.timeColumns.forEach(time => {
      const value = numericValue(row[time.columnIndex]);
      if (value == null) missingMeasurements += 1;
      rawMeasurements.push({
        experiment_id: experimentId,
        measurement_id: measurement.measurementId,
        measurement_type: measurement.measurementType,
        wavelength_nm: measurement.wavelength,
        unit: measurement.unit,
        elapsed_seconds: time.seconds,
        time_h: time.hours,
        time_original: time.original,
        well: wellInfo.normalized,
        well_original: wellInfo.original,
        plate_row: wellMatch[1],
        plate_column: Number(wellMatch[2]),
        content_original: null,
        value_raw: value,
        qc_flag: value == null ? "missing" : ""
      });
    });
  });
  const plate = inferPlateDetails(wells, metadata.plate);
  const durationSeconds = Math.max(...region.timeColumns.map(time => time.seconds));
  return {
    detection,
    metadata,
    rawMeasurements,
    summary: {
      format: "Tecan i-control",
      measurement: `Absorbance at ${measurement.wavelength} nm`,
      measurementType: measurement.measurementType,
      wavelengthNm: measurement.wavelength,
      unit: measurement.unit,
      ...plate,
      wellsDetected: wells.length,
      timePoints: region.timeColumns.length,
      durationSeconds,
      missingMeasurements,
      standardizedRows: rawMeasurements.length,
      sheetName: options.sheetName || "",
      device: metadata.device || ""
    }
  };
}

export function detectBmg(matrix, workbookMeta = {}) {
  const header = findHeader(matrix);
  if (!header) return { format: "unknown", confidence: 0, confidenceLabel: "low", reasons: ["No BMG-style measurement header found"] };
  const timeRow = findTimeRow(matrix, header);
  const metadata = metadataFrom(matrix, header.rowIndex);
  const wells = collectWells(matrix, (timeRow?.rowIndex ?? header.rowIndex) + 1, header.wellIndex);
  let numeric = 0;
  let inspected = 0;
  wells.slice(0, 12).forEach(({ rowIndex }) => {
    (matrix[rowIndex] || []).slice(0, 24).forEach(value => {
      if (value !== "" && value != null) {
        inspected += 1;
        if (typeof value === "number" || /^-?\d+(?:\.\d+)?$/.test(text(value))) numeric += 1;
      }
    });
  });
  const creator = text(workbookMeta.creator).toLowerCase();
  const hasBmgMetadata = ["test id", "test name", "id2"].filter(key => metadata[key]).length;
  let confidence = 0.42;
  const reasons = ["Found Well, Content, and measurement headers"];
  if (timeRow) { confidence += 0.2; reasons.push("Found a following elapsed-time row"); }
  if (wells.length >= 6) { confidence += 0.18; reasons.push(`Found ${wells.length} valid plate wells`); }
  if (hasBmgMetadata >= 2) { confidence += 0.12; reasons.push("Found BMG-style Test ID/Test Name/ID2 metadata"); }
  if (creator.includes("bmg labtech")) { confidence += 0.08; reasons.push("Workbook creator is BMG LABTECH"); }
  else if (inspected && numeric / inspected > 0.5) { confidence += 0.05; reasons.push("Found a numeric measurement matrix"); }
  confidence = Math.min(1, confidence);
  return {
    format: confidence >= 0.65 ? "bmg" : "unknown",
    confidence,
    confidenceLabel: confidence >= 0.85 ? "high" : confidence >= 0.65 ? "medium" : "low",
    reasons,
    header,
    timeRow,
    metadata,
    wells
  };
}

export function parseBmg(matrix, workbookMeta = {}, options = {}) {
  const detection = detectBmg(matrix, workbookMeta);
  if (detection.format !== "bmg" || !detection.timeRow) throw new Error("This worksheet could not be confidently parsed as a BMG LABTECH export.");
  const { header, timeRow, metadata, wells } = detection;
  const measurement = inferMeasurement(matrix, header);
  const timeColumns = timeRow.parsed
    .map((parsed, columnIndex) => parsed ? { ...parsed, columnIndex } : null)
    .filter(Boolean)
    .filter(({ columnIndex }) => columnIndex !== header.wellIndex && columnIndex !== header.contentIndex);
  if (!timeColumns.length) throw new Error("No elapsed-time columns were found after the BMG header.");
  const experimentId = options.experimentId || `exp_${text(metadata["test id"]) || Date.now()}`.replace(/[^A-Za-z0-9_-]+/g, "_");
  const rawMeasurements = [];
  let missingMeasurements = 0;
  wells.forEach(wellInfo => {
    const row = matrix[wellInfo.rowIndex] || [];
    const wellMatch = wellInfo.normalized.match(/^([A-Z])(\d+)$/);
    timeColumns.forEach(time => {
      const cell = row[time.columnIndex];
      const numericValue = typeof cell === "number" ? cell : (text(cell) !== "" && Number.isFinite(Number(cell)) ? Number(cell) : null);
      if (numericValue == null) missingMeasurements += 1;
      rawMeasurements.push({
        experiment_id: experimentId,
        measurement_id: measurement.measurementId,
        measurement_type: measurement.measurementType,
        wavelength_nm: measurement.wavelength,
        unit: measurement.unit,
        elapsed_seconds: time.seconds,
        time_h: time.hours,
        time_original: time.original,
        well: wellInfo.normalized,
        well_original: wellInfo.original,
        plate_row: wellMatch[1],
        plate_column: Number(wellMatch[2]),
        content_original: text(row[header.contentIndex]),
        value_raw: numericValue,
        qc_flag: numericValue == null ? "missing" : ""
      });
    });
  });
  const rows = wells.map(well => well.normalized.charCodeAt(0) - 64);
  const columns = wells.map(well => Number(well.normalized.slice(1)));
  const maxRow = Math.max(...rows);
  const maxColumn = Math.max(...columns);
  const metadataText = Object.entries(metadata).map(([key, value]) => `${key} ${value}`).join(" ");
  const metadataPlateMatch = metadataText.match(/\b(24|48|96|384)\s*(?:-|\s)?well\b/i);
  const inferredPlateWells = maxRow <= 4 && maxColumn <= 6 ? 24 : maxRow <= 6 && maxColumn <= 8 ? 48 : maxRow <= 8 && maxColumn <= 12 ? 96 : 384;
  const metadataPlateWells = metadataPlateMatch ? Number(metadataPlateMatch[1]) : null;
  const plateWells = metadataPlateWells && ((metadataPlateWells === 24 && maxRow <= 4 && maxColumn <= 6) || (metadataPlateWells === 48 && maxRow <= 6 && maxColumn <= 8) || (metadataPlateWells === 96 && maxRow <= 8 && maxColumn <= 12) || (metadataPlateWells === 384 && maxRow <= 16 && maxColumn <= 24)) ? metadataPlateWells : inferredPlateWells;
  const plateSizeSource = metadataPlateWells === plateWells ? "metadata" : "inferred";
  const durationSeconds = Math.max(...timeColumns.map(time => time.seconds));
  return {
    detection,
    metadata,
    rawMeasurements,
    summary: {
      format: "BMG LABTECH",
      measurement: measurement.measurementType === "absorbance" ? `Absorbance${measurement.wavelength ? ` at ${measurement.wavelength} nm` : ""}` : measurement.measurementType,
      measurementType: measurement.measurementType,
      wavelengthNm: measurement.wavelength,
      unit: measurement.unit,
      plateWells,
      plateSizeSource,
      wellsDetected: wells.length,
      timePoints: timeColumns.length,
      durationSeconds,
      missingMeasurements,
      standardizedRows: rawMeasurements.length,
      sheetName: options.sheetName || ""
    }
  };
}

export function parsePlateReaderWorkbook(sheets, workbookMeta = {}, options = {}) {
  const candidates = [];
  const parserErrors = [];
  const parsers = [
    { name: "BMG LABTECH", detect: detectBmg, parse: parseBmg },
    { name: "Tecan i-control", detect: detectTecan, parse: parseTecan }
  ];
  (sheets || []).forEach(sheet => parsers.forEach(parser => {
    const detection = parser.detect(sheet.matrix || [], workbookMeta);
    if (detection.format === "unknown") return;
    try {
      candidates.push(parser.parse(sheet.matrix || [], workbookMeta, {
        ...options,
        sheetName: sheet.sheetName || ""
      }));
    } catch (error) {
      parserErrors.push(`${parser.name} on worksheet "${sheet.sheetName || "(unnamed)"}": ${error.message}`);
    }
  }));
  candidates.sort((a, b) => b.detection.confidence - a.detection.confidence);
  if (candidates.length) return candidates[0];
  const detail = parserErrors.length ? ` ${parserErrors.join(" ")}` : "";
  throw new Error(`Unsupported plate-reader Excel format. No worksheet contained a confidently identifiable BMG LABTECH or Tecan i-control kinetic measurement region.${detail}`);
}

export function toCsv(rows) {
  const escape = value => {
    if (value == null) return "";
    const string = String(value);
    return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  };
  return [RAW_MEASUREMENT_FIELDS.join(","), ...rows.map(row => RAW_MEASUREMENT_FIELDS.map(field => escape(row[field])).join(","))].join("\n");
}
