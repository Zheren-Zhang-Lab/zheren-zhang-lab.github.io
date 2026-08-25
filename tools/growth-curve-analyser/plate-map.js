export const PLATE_MAP_FIELDS = ["well", "sample_id", "condition", "replicate_id", "role", "blank_group"];
export const METADATA_TEMPLATE_FIELDS = ["well", "strain", "condition", "replicate_id", "role", "blank_group"];
export const ALLOWED_ROLES = ["sample", "blank", "control", "unused"];
export const PLATE_LAYOUTS = {
  24: { size: 24, rows: 4, columns: 6, label: "24-well (A1-D6)" },
  48: { size: 48, rows: 6, columns: 8, label: "48-well (A1-F8)" },
  96: { size: 96, rows: 8, columns: 12, label: "96-well (A1-H12)" },
  384: { size: 384, rows: 16, columns: 24, label: "384-well (A1-P24)" }
};

function wellParts(well) {
  const match = String(well ?? "").trim().match(/^([A-Za-z])0*([1-9]|1\d|2[0-4])$/);
  return match ? { row: match[1].toUpperCase(), rowNumber: match[1].toUpperCase().charCodeAt(0) - 64, column: Number(match[2]) } : null;
}

export function normalizeMetadataWell(well) {
  const parts = wellParts(well);
  return parts ? `${parts.row}${parts.column}` : null;
}

export function sortWells(a, b) {
  const left = wellParts(a), right = wellParts(b);
  if (!left || !right) return String(a).localeCompare(String(b));
  return left.rowNumber - right.rowNumber || left.column - right.column;
}

export function getPlateLayout(size) {
  const layout = PLATE_LAYOUTS[Number(size)];
  if (!layout) throw new Error(`Unsupported plate size: ${size}`);
  return layout;
}

export function layoutWells(size) {
  const layout = getPlateLayout(size);
  const wells = [];
  for (let row = 1; row <= layout.rows; row += 1) {
    const letter = String.fromCharCode(64 + row);
    for (let column = 1; column <= layout.columns; column += 1) wells.push(`${letter}${column}`);
  }
  return wells;
}

export function layoutContainsWell(size, well) {
  const layout = getPlateLayout(size);
  const parts = wellParts(well);
  return Boolean(parts && parts.rowNumber <= layout.rows && parts.column <= layout.columns);
}

export function inferPlateSizeFromWells(wells) {
  const normalized = wells.map(normalizeMetadataWell).filter(Boolean);
  return [24, 48, 96, 384].find(size => normalized.every(well => layoutContainsWell(size, well))) || 384;
}

function emptyRow(well) {
  return { well, sample_id: "", condition: "", replicate_id: "", role: "", blank_group: "" };
}

export function createPlateMap(rawMeasurements, plateSize) {
  const rawWells = [...new Set(rawMeasurements.map(row => row.well).filter(Boolean))];
  const size = Number(plateSize) || inferPlateSizeFromWells(rawWells);
  if (!rawWells.every(well => layoutContainsWell(size, well))) throw new Error(`Observed wells do not fit a ${size}-well plate.`);
  return layoutWells(size).map(emptyRow);
}

export function resizePlateMap(plateMap, plateSize) {
  const existing = new Map(plateMap.map(row => [row.well, row]));
  return layoutWells(plateSize).map(well => existing.has(well) ? { ...existing.get(well) } : emptyRow(well));
}

export function assignPlateMetadata(plateMap, selectedWells, metadata, autoReplicates = true) {
  const selected = new Set(selectedWells);
  const ordered = [...selected].sort(sortWells);
  const replicateByWell = new Map();
  if (autoReplicates) {
    const prefix = metadata.role === "blank" ? "blank" : metadata.role === "control" ? "control" : "bio";
    ordered.forEach((well, index) => replicateByWell.set(well, `${prefix}_${index + 1}`));
  }
  return plateMap.map(row => selected.has(row.well) ? {
    ...row,
    sample_id: metadata.sample_id ?? row.sample_id,
    condition: metadata.condition ?? row.condition,
    role: metadata.role ?? row.role,
    blank_group: metadata.blank_group ?? row.blank_group,
    replicate_id: autoReplicates ? replicateByWell.get(row.well) : (metadata.replicate_id ?? row.replicate_id)
  } : row);
}

export function clearPlateAssignments(plateMap, selectedWells) {
  const selected = new Set(selectedWells);
  return plateMap.map(row => selected.has(row.well) ? emptyRow(row.well) : row);
}

function clean(value) { return value == null ? "" : String(value).trim(); }

export function validateMetadataRows(rows, plateSize) {
  const errors = [];
  const seen = new Map();
  const normalizedRows = [];
  rows.forEach((source, index) => {
    const sourceRow = index + 2;
    const originalWell = clean(source.well);
    const hasAnyValue = METADATA_TEMPLATE_FIELDS.some(field => clean(source[field]));
    if (!hasAnyValue) return;
    const well = normalizeMetadataWell(originalWell);
    if (!well) {
      errors.push({ row: sourceRow, code: "invalid_well", message: `Row ${sourceRow}: invalid well "${originalWell || "(blank)"}".` });
      return;
    }
    if (!layoutContainsWell(plateSize, well)) {
      errors.push({ row: sourceRow, code: "well_outside_layout", message: `Row ${sourceRow}: ${well} is outside the selected ${plateSize}-well layout.` });
    }
    if (seen.has(well)) {
      errors.push({ row: sourceRow, code: "duplicate_well", message: `Row ${sourceRow}: duplicate well ${well} (first used on row ${seen.get(well)}).` });
    } else seen.set(well, sourceRow);
    const role = clean(source.role).toLowerCase();
    if (role && !ALLOWED_ROLES.includes(role)) {
      errors.push({ row: sourceRow, code: "invalid_role", message: `Row ${sourceRow}: role "${source.role}" is invalid. Use sample, blank, control, or unused.` });
    }
    normalizedRows.push({
      well,
      sample_id: clean(source.strain),
      condition: clean(source.condition),
      replicate_id: clean(source.replicate_id),
      role,
      blank_group: clean(source.blank_group)
    });
  });
  return { valid: errors.length === 0, errors, rows: normalizedRows };
}

export function importPlateMetadata(plateMap, rows, plateSize) {
  const validation = validateMetadataRows(rows, plateSize);
  if (!validation.valid) return { ...validation, plateMap };
  const imported = new Map(validation.rows.map(row => [row.well, row]));
  return {
    ...validation,
    plateMap: plateMap.map(row => imported.has(row.well) ? { ...row, ...imported.get(row.well) } : row)
  };
}

function csvEscape(value) {
  const string = value == null ? "" : String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function metadataTemplateCsv(plateSize) {
  return [METADATA_TEMPLATE_FIELDS.join(","), ...layoutWells(plateSize).map(well => [well, "", "", "", "", ""].join(","))].join("\n");
}

export function plateMapToCsv(plateMap) {
  return [PLATE_MAP_FIELDS.join(","), ...plateMap.map(row => PLATE_MAP_FIELDS.map(field => csvEscape(row[field])).join(","))].join("\n");
}
