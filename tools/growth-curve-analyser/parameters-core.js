import { tCritical95 } from "./summary.js";
import { GCPLYR_VERSION } from "./webr-gcplyr-config.js";

export const PARAMETER_SETTINGS = Object.freeze({
  engine: "gcplyr", version: GCPLYR_VERSION,
  input: "processed_measurements.value_corrected", timeUnit: "hours",
  smoothing: "No pre-smoothing of OD values",
  derivative: 'calc_deriv(percapita = TRUE, trans_y = "log", blank = 0, window_width_n = 5)',
  lagTime: 'lag_time(deriv = same 5-point log-scale derivative, trans_y = "log", blank = 0)',
  maximum: "max_gc(value_corrected)", auc: "auc(time_h, value_corrected)"
});
export const REPLICATE_PARAMETER_FIELDS = [
  "well", "strain", "condition", "replicate_id", "role",
  "max_growth_rate_per_h", "doubling_time_h", "lag_time_h",
  "max_od", "auc_od_h", "n_time_points", "analysis_status", "analysis_message"
];
export const SUMMARY_PARAMETER_FIELDS = [
  "strain", "condition", "parameter", "unit",
  "mean", "sd", "sem", "ci95_lower", "ci95_upper", "n"
];
export const PARAMETER_DEFINITIONS = [
  { key: "max_growth_rate_per_h", label: "Maximum growth rate", unit: "h^-1" },
  { key: "doubling_time_h", label: "Doubling time", unit: "h" },
  { key: "lag_time_h", label: "Lag time", unit: "h" },
  { key: "max_od", label: "Maximum OD", unit: "OD" },
  { key: "auc_od_h", label: "Area under curve", unit: "OD·h" }
];

export function eligibleParameterMeasurements(rows) {
  return rows.filter(row =>
    (row.role === "sample" || row.role === "control") &&
    Number.isFinite(Number(row.time_h)) &&
    Number.isFinite(Number(row.value_corrected))
  );
}
function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function rowsToCsv(rows, fields) {
  return [fields.join(","), ...rows.map(row => fields.map(field => csvEscape(row[field])).join(","))].join("\n");
}
export function parameterInputToCsv(rows) {
  const fields = ["time_h", "elapsed_seconds", "well", "sample_id", "condition", "replicate_id", "role", "value_corrected"];
  return rowsToCsv(rows, fields);
}

export function gcplyrParameterScript(expectedVersion = GCPLYR_VERSION) {
  return `
library(gcplyr)
actual_version <- as.character(packageVersion("gcplyr"))
if (!identical(actual_version, "${expectedVersion}")) {
  stop(sprintf("Pinned gcplyr version mismatch: expected ${expectedVersion}, received %s", actual_version))
}
measurements <- read.csv("/tmp/processed_measurements.csv", stringsAsFactors = FALSE, check.names = FALSE)
measurements <- measurements[measurements$role %in% c("sample", "control"), ]
curves <- split(measurements, measurements$well)
analyze_curve <- function(curve) {
  curve <- curve[order(curve$time_h), ]
  curve <- curve[is.finite(curve$time_h) & is.finite(curve$value_corrected), ]
  base <- data.frame(
    well = curve$well[1], strain = curve$sample_id[1], condition = curve$condition[1],
    replicate_id = curve$replicate_id[1], role = curve$role[1], stringsAsFactors = FALSE
  )
  qc_warnings <- character()
  tryCatch(withCallingHandlers({
    if (nrow(curve) < 5) stop("At least five finite time points are required for window_width_n = 5.")
    if (anyDuplicated(curve$time_h)) stop("Duplicate time points are not supported.")
    if (any(diff(curve$time_h) <= 0)) stop("Time points must be strictly increasing.")
    x <- curve$time_h
    y <- curve$value_corrected
    deriv <- calc_deriv(
      y = y, x = x, percapita = TRUE, blank = 0, trans_y = "log",
      window_width_n = 5, warn_ungrouped = FALSE
    )
    max_rate <- max_gc(deriv)
    lag <- lag_time(
      x = x, y = y, deriv = deriv, blank = 0, trans_y = "log"
    )
    data.frame(
      base, max_growth_rate_per_h = max_rate,
      doubling_time_h = doubling_time(max_rate), lag_time_h = lag,
      max_od = max_gc(y), auc_od_h = auc(x = x, y = y),
      n_time_points = nrow(curve),
      analysis_status = if (length(qc_warnings)) "warning" else "ok",
      analysis_message = paste(unique(qc_warnings), collapse = " | "),
      stringsAsFactors = FALSE
    )
  }, warning = function(w) {
    qc_warnings <<- c(qc_warnings, conditionMessage(w))
    invokeRestart("muffleWarning")
  }), error = function(e) {
    data.frame(
      base, max_growth_rate_per_h = NA_real_, doubling_time_h = NA_real_,
      lag_time_h = NA_real_, max_od = NA_real_, auc_od_h = NA_real_,
      n_time_points = nrow(curve), analysis_status = "error",
      analysis_message = paste(c(unique(qc_warnings), conditionMessage(e)), collapse = " | "),
      stringsAsFactors = FALSE
    )
  })
}
results <- do.call(rbind, lapply(curves, analyze_curve))
write.csv(results, "/tmp/gcplyr_parameter_results.csv", row.names = FALSE, na = "")
`;
}

function parseCsvLine(line) {
  const cells = []; let current = ""; let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(current); current = ""; }
    else current += char;
  }
  cells.push(current); return cells;
}
export function parseParameterCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || "");
  const numeric = new Set(["max_growth_rate_per_h", "doubling_time_h", "lag_time_h", "max_od", "auc_od_h", "n_time_points"]);
  return lines.filter(Boolean).map(line => Object.fromEntries(parseCsvLine(line).map((value, index) => {
    const field = headers[index];
    return [field, numeric.has(field) ? (value === "" ? null : Number(value)) : value];
  })));
}
function stats(values) {
  const clean = values.filter(value => typeof value === "number" && Number.isFinite(value));
  const n = clean.length;
  if (!n) return { mean: null, sd: null, sem: null, ci95_lower: null, ci95_upper: null, n: 0 };
  const mean = clean.reduce((sum, value) => sum + value, 0) / n;
  const sd = n > 1 ? Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : null;
  const sem = n > 1 ? sd / Math.sqrt(n) : null;
  const critical = n > 1 ? tCritical95(n - 1) : null;
  const margin = critical == null ? null : critical * sem;
  return { mean, sd, sem, ci95_lower: margin == null ? null : mean - margin, ci95_upper: margin == null ? null : mean + margin, n };
}
export function summarizeParameters(rows) {
  const groups = new Map();
  rows.filter(row => row.analysis_status !== "error").forEach(row => {
    const key = [row.strain || "", row.condition || ""].join("\u001f");
    if (!groups.has(key)) groups.set(key, { strain: row.strain || "", condition: row.condition || "", rows: [] });
    groups.get(key).rows.push(row);
  });
  return [...groups.values()].flatMap(group => PARAMETER_DEFINITIONS.map(parameter => ({
    strain: group.strain, condition: group.condition,
    parameter: parameter.label, unit: parameter.unit,
    ...stats(group.rows.map(row => row[parameter.key]))
  }))).sort((a, b) => a.strain.localeCompare(b.strain) || a.condition.localeCompare(b.condition) || a.parameter.localeCompare(b.parameter));
}
export function parameterMethodsSentences(version = GCPLYR_VERSION) {
  return [
    `Growth parameters were estimated independently for each eligible sample and control well from processed_measurements using a SHA-256-verified gcplyr version ${version} binary artifact in browser-side webR 0.6.0.`,
    'The analysis used value_corrected, representing blank-corrected measurements when blank correction was selected and raw-equivalent measurements when “No blank correction” was selected, with time expressed in hours.',
    'No pre-smoothing was applied to OD values; the per-capita derivative curve was calculated with gcplyr::calc_deriv(percapita = TRUE, trans_y = "log", blank = 0, window_width_n = 5), using local linear regression of log-transformed density over five time points.',
    'Maximum growth rate was obtained with gcplyr::max_gc(deriv), and doubling time was calculated from that maximum rate with gcplyr::doubling_time().',
    'Lag time was estimated with gcplyr::lag_time() using the same five-point log-scale derivative, trans_y = "log", and blank = 0; maximum OD was calculated with gcplyr::max_gc(value_corrected), and AUC with gcplyr::auc(x = time_h, y = value_corrected).',
    "Parameters were summarized across wells sharing strain and condition; SD was the sample standard deviation, SEM was SD/√n, and 95% confidence intervals used Student's t distribution with df = n - 1, with SD, SEM, and confidence intervals left undefined when n < 2.",
    'These summaries assume that wells treated as replicates are independent; replicate_id does not distinguish biological from technical replicates in V1.'
  ];
}
export function parameterMethodsText(version = GCPLYR_VERSION) {
  return parameterMethodsSentences(version).map(sentence => `• ${sentence}`).join("\n");
}
