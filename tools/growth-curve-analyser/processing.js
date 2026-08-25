export const PROCESSED_MEASUREMENT_FIELDS = [
  "experiment_id", "measurement_id", "measurement_type", "wavelength_nm", "unit",
  "elapsed_seconds", "time_h", "well", "sample_id", "condition", "replicate_id",
  "role", "blank_group", "value_raw", "blank_value", "value_corrected",
  "correction_method", "processing_version", "qc_flag"
];

const TARGET_ROLES = new Set(["sample", "control"]);

function measuredWellSet(rawMeasurements) {
  return new Set(rawMeasurements.map(row => row.well));
}

export function validateBlankCorrection(rawMeasurements, plateMap, method = "mean_blank_group") {
  const measured = measuredWellSet(rawMeasurements);
  const rows = plateMap.filter(row => measured.has(row.well));
  const targets = rows.filter(row => TARGET_ROLES.has(row.role));
  const blanks = rows.filter(row => row.role === "blank");
  const errors = [];
  const warnings = [];
  const targetGroups = new Set(targets.map(row => row.blank_group).filter(Boolean));
  const blankGroups = new Set(blanks.map(row => row.blank_group).filter(Boolean));

  const unassignedCount = rows.filter(row => !row.role).length;
  if (unassignedCount) warnings.push({ code: "unassigned_wells", message: `${unassignedCount} measured wells have no role and will be excluded.` });
  const missingReplicates = targets.filter(row => !row.replicate_id).map(row => row.well);
  if (missingReplicates.length) warnings.push({ code: "missing_replicate_id", message: `${missingReplicates.length} sample/control wells have no replicate_id: ${missingReplicates.join(", ")}.` });
  const blankWithoutGroup = blanks.filter(row => !row.blank_group).map(row => row.well);
  if (blankWithoutGroup.length) warnings.push({ code: "blank_without_group", message: `Blank wells without blank_group will not be used: ${blankWithoutGroup.join(", ")}.` });
  const unusedBlankGroups = [...blankGroups].filter(group => !targetGroups.has(group));
  if (unusedBlankGroups.length) warnings.push({ code: "unused_blank_groups", message: `Blank groups not used by sample/control wells: ${unusedBlankGroups.join(", ")}.` });

  const missingGroupTargets = targets.filter(row => !row.blank_group);
  const unmatchedGroups = [...targetGroups].filter(group => !blankGroups.has(group));
  if (method === "mean_blank_group") {
    if (missingGroupTargets.length) errors.push({ code: "target_without_blank_group", message: `Sample/control wells missing blank_group: ${missingGroupTargets.map(row => row.well).join(", ")}.` });
    if (unmatchedGroups.length) errors.push({ code: "unmatched_blank_groups", message: `No matching blank wells for blank_group: ${unmatchedGroups.join(", ")}.` });
  } else {
    if (missingGroupTargets.length) warnings.push({ code: "target_without_blank_group", message: `${missingGroupTargets.length} sample/control wells have no blank_group; allowed because no correction is selected.` });
    if (unmatchedGroups.length) warnings.push({ code: "unmatched_blank_groups", message: `Unmatched blank groups (${unmatchedGroups.join(", ")}) are ignored because no correction is selected.` });
  }
  if (!targets.length) errors.push({ code: "no_target_wells", message: "No measured wells are assigned role sample or control." });

  return { valid: errors.length === 0, errors, warnings, targets, blanks };
}

function mean(values) {
  const numeric = values.filter(value => typeof value === "number" && Number.isFinite(value));
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

export function generateProcessedMeasurements(rawMeasurements, plateMap, method = "mean_blank_group") {
  const validation = validateBlankCorrection(rawMeasurements, plateMap, method);
  if (!validation.valid) return { ...validation, processedMeasurements: [], summary: null };

  const mapByWell = new Map(plateMap.map(row => [row.well, row]));
  const blankValues = new Map();
  if (method === "mean_blank_group") {
    rawMeasurements.forEach(raw => {
      const meta = mapByWell.get(raw.well);
      if (meta?.role !== "blank" || !meta.blank_group) return;
      const key = [raw.measurement_id, raw.elapsed_seconds, meta.blank_group].join("|");
      if (!blankValues.has(key)) blankValues.set(key, []);
      blankValues.get(key).push(raw.value_raw);
    });
  }

  const processedMeasurements = [];
  rawMeasurements.forEach(raw => {
    const meta = mapByWell.get(raw.well);
    if (!meta || !TARGET_ROLES.has(meta.role)) return;
    const key = [raw.measurement_id, raw.elapsed_seconds, meta.blank_group].join("|");
    const blankValue = method === "mean_blank_group" ? mean(blankValues.get(key) || []) : null;
    const corrected = method === "mean_blank_group"
      ? (typeof raw.value_raw === "number" && typeof blankValue === "number" ? raw.value_raw - blankValue : null)
      : raw.value_raw;
    const flags = [raw.qc_flag, method === "mean_blank_group" && blankValue == null ? "missing_blank_value" : ""].filter(Boolean);
    processedMeasurements.push({
      experiment_id: raw.experiment_id,
      measurement_id: raw.measurement_id,
      measurement_type: raw.measurement_type,
      wavelength_nm: raw.wavelength_nm,
      unit: raw.unit,
      elapsed_seconds: raw.elapsed_seconds,
      time_h: raw.time_h,
      well: raw.well,
      sample_id: meta.sample_id,
      condition: meta.condition,
      replicate_id: meta.replicate_id,
      role: meta.role,
      blank_group: meta.blank_group,
      value_raw: raw.value_raw,
      blank_value: blankValue,
      value_corrected: corrected,
      correction_method: method,
      processing_version: "m2b-1",
      qc_flag: [...new Set(flags)].join(";")
    });
  });

  const targetWells = new Set(processedMeasurements.map(row => row.well));
  const sampleIds = new Set(validation.targets.map(row => row.sample_id).filter(Boolean));
  const conditions = new Set(validation.targets.map(row => row.condition).filter(Boolean));
  const timePoints = new Set(processedMeasurements.map(row => row.elapsed_seconds));
  const usedGroups = new Set(validation.targets.map(row => row.blank_group).filter(Boolean));
  const usedBlankWells = validation.blanks.filter(row => usedGroups.has(row.blank_group));
  return {
    ...validation,
    processedMeasurements,
    summary: {
      samples: sampleIds.size,
      conditions: conditions.size,
      replicateCurves: targetWells.size,
      sampleWells: validation.targets.filter(row => row.role === "sample").length,
      controlWells: validation.targets.filter(row => row.role === "control").length,
      blankWells: usedBlankWells.length,
      timePoints: timePoints.size,
      processedRows: processedMeasurements.length,
      correctionMethod: method
    }
  };
}

function escapeCsv(value) {
  const string = value == null ? "" : String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function processedMeasurementsToCsv(rows) {
  return [PROCESSED_MEASUREMENT_FIELDS.join(","), ...rows.map(row => PROCESSED_MEASUREMENT_FIELDS.map(field => escapeCsv(row[field])).join(","))].join("\n");
}
