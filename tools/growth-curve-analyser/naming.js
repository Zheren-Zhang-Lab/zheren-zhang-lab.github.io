export const DATA_STAGES = ["raw_standardized", "plate_map", "processed", "summary", "parameters"];

export function sanitizeExperimentName(value) {
  const cleaned = String(value ?? "").trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 100);
  return cleaned || "growth_curve";
}

export function defaultExperimentName(metadata = {}, fileName = "") {
  const instrumentName = String(metadata["test name"] ?? "").trim();
  if (instrumentName) return instrumentName;
  const base = String(fileName).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();
  return base || "growth_curve";
}

export function buildDataFilename(experimentName, stage, extension = "csv") {
  if (!DATA_STAGES.includes(stage)) throw new Error(`Unsupported data stage: ${stage}`);
  return `${sanitizeExperimentName(experimentName)}_${stage}.${String(extension).replace(/^\./, "")}`;
}

export function buildMetadataTemplateFilename(experimentName, extension) {
  return `${sanitizeExperimentName(experimentName)}_plate_metadata_template.${String(extension).replace(/^\./, "")}`;
}

export function buildPlotFilename(experimentName, extension) {
  return `${sanitizeExperimentName(experimentName)}_growth_curves.${String(extension).replace(/^\./, "")}`;
}

export function buildParameterFilename(experimentName, level) {
  if (!["replicates", "summary"].includes(level)) throw new Error(`Unsupported parameter level: ${level}`);
  return `${sanitizeExperimentName(experimentName)}_parameters_${level}.csv`;
}
