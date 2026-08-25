export const SUMMARY_FIELDS = ["time_h", "strain", "condition", "mean", "sd", "sem", "ci95_lower", "ci95_upper", "n"];

const T95 = [null,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262,2.228,2.201,2.179,2.160,2.145,2.131,2.120,2.110,2.101,2.093,2.086,2.080,2.074,2.069,2.064,2.060,2.056,2.052,2.048,2.045,2.042];

export function tCritical95(df) {
  if (df < 1) return null;
  if (df <= 30) return T95[df];
  const z = 1.959963984540054;
  const v = df;
  return z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3);
}

function stats(values) {
  const clean = values.filter(value => typeof value === "number" && Number.isFinite(value));
  const n = clean.length;
  if (!n) return { mean: null, sd: null, sem: null, ci95_lower: null, ci95_upper: null, n: 0 };
  const mean = clean.reduce((sum, value) => sum + value, 0) / n;
  const sd = n > 1 ? Math.sqrt(clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0;
  const sem = n > 1 ? sd / Math.sqrt(n) : null;
  const margin = n > 1 ? tCritical95(n - 1) * sem : null;
  return { mean, sd, sem, ci95_lower: margin == null ? null : mean - margin, ci95_upper: margin == null ? null : mean + margin, n };
}

export function summarizeProcessedMeasurements(rows, valueField = "value_corrected") {
  const groups = new Map();
  rows.forEach(row => {
    const value = row[valueField];
    const key = [row.sample_id, row.condition, row.elapsed_seconds].join("\u001f");
    if (!groups.has(key)) groups.set(key, { time_h: row.time_h, elapsed_seconds: row.elapsed_seconds, strain: row.sample_id || "", condition: row.condition || "", values: [] });
    groups.get(key).values.push(value);
  });
  return [...groups.values()].map(group => ({ time_h: group.time_h, strain: group.strain, condition: group.condition, ...stats(group.values) }))
    .sort((a,b) => a.strain.localeCompare(b.strain) || a.condition.localeCompare(b.condition) || a.time_h - b.time_h);
}

function csvEscape(value) {
  const string = value == null ? "" : String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"','""')}"` : string;
}

export function summaryToCsv(rows) {
  return [SUMMARY_FIELDS.join(","), ...rows.map(row => SUMMARY_FIELDS.map(field => csvEscape(row[field])).join(","))].join("\n");
}
