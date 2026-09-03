import { RAW_MEASUREMENT_FIELDS, parsePlateReaderWorkbook, toCsv } from "./parser-core.js";
import { PLATE_LAYOUTS, createPlateMap, resizePlateMap, assignPlateMetadata, clearPlateAssignments, plateMapToCsv, sortWells, getPlateLayout, layoutWells, layoutContainsWell, importPlateMetadata, metadataTemplateCsv, METADATA_TEMPLATE_FIELDS } from "./plate-map.js";
import { validateBlankCorrection, generateProcessedMeasurements, processedMeasurementsToCsv } from "./processing.js";
import { defaultExperimentName, sanitizeExperimentName, buildDataFilename, buildMetadataTemplateFilename, buildPlotFilename, buildParameterFilename } from "./naming.js";
import { summarizeProcessedMeasurements, summaryToCsv } from "./summary.js";
import { eligibleParameterMeasurements, summarizeParameters, parameterMethodsSentences, parameterMethodsText, rowsToCsv, REPLICATE_PARAMETER_FIELDS, SUMMARY_PARAMETER_FIELDS, PARAMETER_SETTINGS } from "./parameters-core.js";
import { runGcplyrParameters } from "./parameters-webr.js";
import { WEBR_VERSION, GCPLYR_VERSION, GCPLYR_CITATION, GCPLYR_ARTIFACT_SHA256 } from "./webr-gcplyr-config.js";

const $ = selector => document.querySelector(selector);
const state = { result: null, fileName: "", plateMap: [], plateSize: 96, measuredWells: new Set(), selectedWells: new Set(), dragging: false, processedMeasurements: [], processingSummary: null, experimentName: "growth_curve", plotSummary: [], parameterRows: [], parameterSummary: [] };
const workflowOrder = ["upload", "detect", "standardize", "map", "correct", "plot", "parameters"];

function setWorkflowStep(currentStep) {
  const currentIndex = workflowOrder.indexOf(currentStep);
  document.querySelectorAll(".workflow-step").forEach(step => {
    const index = workflowOrder.indexOf(step.dataset.step);
    step.classList.toggle("completed", index < currentIndex);
    step.classList.toggle("current", index === currentIndex);
    if (index === currentIndex) step.setAttribute("aria-current", "step"); else step.removeAttribute("aria-current");
  });
  document.querySelectorAll("#workflow > i").forEach((line, index) => line.classList.toggle("completed", index < currentIndex));
}

function durationLabel(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.round((seconds % 3600) / 60);
  return [days ? `${days} d` : "", hours ? `${hours} h` : "", minutes || (!days && !hours) ? `${minutes} min` : ""].filter(Boolean).join(" ");
}
function setStatus(message, type = "") { const node = $("#upload-status"); node.textContent = message; node.className = `upload-status ${type}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function downloadBlob(data, fileName, type) {
  const url = URL.createObjectURL(new Blob([data], { type })); const link = document.createElement("a");
  link.href = url; link.download = fileName; link.click(); URL.revokeObjectURL(url);
}
function downloadText(text, fileName, type = "text/csv;charset=utf-8") { downloadBlob(text, fileName, type); }
function dataFilename(stage, extension = "csv") { return buildDataFilename(state.experimentName, stage, extension); }

async function downloadExcelMetadataTemplate() {
  if (!window.ExcelJS) throw new Error("The Excel template generator did not load. Check your connection and refresh the page.");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Zheren Lab Growth Curve Analyser";
  workbook.subject = "Metadata template for " + state.experimentName + " (" + state.plateSize + "-well plate)";
  const sheet = workbook.addWorksheet("Plate Metadata", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "well", key: "well", width: 12 }, { header: "strain", key: "strain", width: 22 },
    { header: "condition", key: "condition", width: 26 }, { header: "replicate_id", key: "replicate_id", width: 18 },
    { header: "role", key: "role", width: 16 }, { header: "blank_group", key: "blank_group", width: 20 }
  ];
  layoutWells(state.plateSize).forEach(well => sheet.addRow({ well }));
  sheet.autoFilter = { from: "A1", to: "F1" };
  sheet.getRow(1).font = { bold: true, color: { argb: "FF071318" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4FD1C5" } };
  sheet.getRow(1).alignment = { vertical: "middle" };
  sheet.getRow(1).height = 22;
  for (let row = 2; row <= state.plateSize + 1; row += 1) {
    sheet.getCell("E" + row).dataValidation = { type: "list", allowBlank: true, formulae: ['"sample,blank,control,unused"'], showErrorMessage: true, errorStyle: "stop", errorTitle: "Invalid role", error: "Choose sample, blank, control, or unused." };
  }
  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [{ width: 20 }, { width: 62 }, { width: 30 }];
  instructions.addRows([
    ["Metadata template", "For the currently selected " + state.plateSize + "-well plate. You may leave wells without metadata blank.", ""],
    ["Column", "Description", "Example"],
    ["well", "Plate well identifier. Pre-filled; do not duplicate wells.", "A1"],
    ["strain", "Biological strain or sample identity. Wells with the same strain and condition can later be grouped for summary plots such as mean +/- SD.", "WT"],
    ["condition", "Experimental growth condition. Together with strain, this defines the sample group for downstream averaging and comparison.", "M9 + glucose"],
    ["replicate_id", "Identifier for an individual replicate within the same strain and condition. Use simple labels such as 1, 2, 3.", "1"],
    ["role", "Choose exactly one of sample, blank, control, or unused. Use the dropdown in the Plate Metadata sheet.", "sample"],
    ["blank_group", "Links sample wells to the blank wells used for background correction. Sample and blank wells that should be matched must use exactly the same blank-group name.", "M9_glucose"]
  ]);
  instructions.getRow(1).font = { bold: true, size: 14, color: { argb: "FF4FD1C5" } };
  instructions.getRow(2).font = { bold: true, color: { argb: "FF071318" } };
  instructions.getRow(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4FD1C5" } };
  instructions.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(buffer, buildMetadataTemplateFilename(state.experimentName, "xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

async function readWorkbook(file) {
  if (!window.XLSX) throw new Error("The Excel reader did not load. Check your internet connection and refresh the page.");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, raw: true });
  const sheets = workbook.SheetNames.map(sheetName => ({
    sheetName,
    matrix: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null })
  }));
  return parsePlateReaderWorkbook(sheets, workbook.Props || {});
}

function renderSummary() {
  const { summary, detection, rawMeasurements } = state.result;
  $("#detected-file").textContent = state.fileName;
  $("#experiment-name").value = state.experimentName;
  $("#experiment-filename-preview").textContent = sanitizeExperimentName(state.experimentName);
  $("#confidence").textContent = `${Math.round(detection.confidence * 100)}% - ${detection.confidenceLabel}`;
  $("#detection-format-label").textContent = `Why was this detected as ${summary.format}?`;
  const fields = [["Format", summary.format], ["Measurement", summary.measurement], ["Unit", summary.unit], ["Plate", `${summary.plateWells} wells`], ["Wells detected", summary.wellsDetected], ["Time points", summary.timePoints], ["Duration", durationLabel(summary.durationSeconds)], ["Missing measurements", summary.missingMeasurements], ["Standardized rows", summary.standardizedRows]];
  $("#summary-grid").innerHTML = fields.map(([label, value]) => `<div class="metric"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("#detection-reasons").innerHTML = detection.reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("");
  const preview = rawMeasurements.slice(0, 8);
  $("#preview-head").innerHTML = RAW_MEASUREMENT_FIELDS.map(field => `<th>${field}</th>`).join("");
  $("#preview-body").innerHTML = preview.map(row => `<tr>${RAW_MEASUREMENT_FIELDS.map(field => `<td>${escapeHtml(row[field])}</td>`).join("")}</tr>`).join("");
  $("#upload-panel").hidden = true; $("#result-panel").hidden = false; setWorkflowStep("standardize");
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.(xlsx|xls)$/i.test(file.name)) { setStatus("Plate-reader import supports Excel files (.xlsx or .xls).", "error"); return; }
  state.fileName = file.name; setWorkflowStep("detect"); setStatus(`Reading ${file.name} locally...`, "working");
  try {
    state.result = await readWorkbook(file);
    state.experimentName = defaultExperimentName(state.result.metadata, state.fileName);
    state.plateSize = Number(state.result.summary.plateWells) || 96;
    state.measuredWells = new Set(state.result.rawMeasurements.map(row => row.well));
    state.plateMap = createPlateMap(state.result.rawMeasurements, state.plateSize);
    renderSummary();
  } catch (error) { setStatus(error.message, "error"); $("#manual-format").hidden = false; }
}

function configurePlateSizeSelector() {
  const rawWells = [...new Set(state.result.rawMeasurements.map(row => row.well))];
  $("#plate-size").innerHTML = Object.values(PLATE_LAYOUTS).map(layout => {
    const fits = rawWells.every(well => layoutContainsWell(layout.size, well));
    return `<option value="${layout.size}" ${fits ? "" : "disabled"}>${layout.label}${fits ? "" : " - smaller than observed wells"}</option>`;
  }).join("");
  $("#plate-size").value = String(state.plateSize);
  const source = state.result.summary.plateSizeSource === "metadata" ? "Read from instrument metadata." : "Inferred from observed well IDs. Please confirm or change it.";
  $("#plate-size-note").textContent = source;
}

function selectWells(wells, additive = false) {
  if (!additive) state.selectedWells.clear();
  wells.forEach(well => state.selectedWells.add(well));
  renderPlateSelection();
}

function renderPlateMap() {
  const layout = getPlateLayout(state.plateSize);
  const measured = new Set(state.result.rawMeasurements.map(row => row.well));
  const byWell = new Map(state.plateMap.map(row => [row.well, row]));
  const columns = Array.from({ length: layout.columns }, (_, index) => index + 1);
  $("#plate-grid").dataset.size = String(state.plateSize);
  $("#plate-grid").style.gridTemplateColumns = `28px repeat(${layout.columns}, minmax(28px, 1fr))`;
  $("#plate-grid").style.minWidth = `${Math.max(430, 35 + layout.columns * (layout.size === 384 ? 30 : 48))}px`;
  let html = '<div class="plate-corner"></div>' + columns.map(column => `<button type="button" class="plate-axis column-select" data-column="${column}">${column}</button>`).join("");
  for (let row = 1; row <= layout.rows; row += 1) {
    const letter = String.fromCharCode(64 + row);
    html += `<button type="button" class="plate-axis row-select" data-row="${letter}">${letter}</button>`;
    columns.forEach(column => {
      const well = `${letter}${column}`, record = byWell.get(well);
      html += `<button type="button" class="well${measured.has(well) ? "" : " no-measurement"}" data-well="${well}" aria-label="Well ${well}" title="${well}${measured.has(well) ? "" : " - no raw measurement"}"><span>${well}</span></button>`;
    });
  }
  $("#plate-grid").setAttribute("aria-label", `${state.plateSize}-well plate map`);
  $("#plate-grid").innerHTML = html;
  bindPlateEvents(); renderPlateSelection();
}

function bindPlateEvents() {
  $("#plate-grid").querySelectorAll(".well").forEach(button => {
    button.addEventListener("pointerdown", event => {
      event.preventDefault(); state.dragging = true;
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!additive) state.selectedWells.clear();
      const well = button.dataset.well;
      if (additive && state.selectedWells.has(well)) state.selectedWells.delete(well); else state.selectedWells.add(well);
      renderPlateSelection();
    });
    button.addEventListener("pointerenter", () => { if (state.dragging) { state.selectedWells.add(button.dataset.well); renderPlateSelection(); } });
  });
  $("#plate-grid").querySelectorAll(".row-select").forEach(button => button.addEventListener("click", event => selectWells(state.plateMap.filter(row => row.well.startsWith(button.dataset.row)).map(row => row.well), event.shiftKey || event.metaKey || event.ctrlKey)));
  $("#plate-grid").querySelectorAll(".column-select").forEach(button => button.addEventListener("click", event => selectWells(state.plateMap.filter(row => Number(row.well.slice(1)) === Number(button.dataset.column)).map(row => row.well), event.shiftKey || event.metaKey || event.ctrlKey)));
}
window.addEventListener("pointerup", () => { state.dragging = false; });

function renderPlateSelection() {
  const records = new Map(state.plateMap.map(row => [row.well, row]));
  $("#plate-grid").querySelectorAll(".well").forEach(button => {
    const record = records.get(button.dataset.well), noMeasurement = !state.measuredWells.has(button.dataset.well);
    button.className = "well";
    if (noMeasurement) button.classList.add("no-measurement");
    if (record?.role) button.classList.add("assigned", `role-${record.role}`);
    if (state.selectedWells.has(button.dataset.well)) button.classList.add("selected");
    button.title = record ? [record.well, record.sample_id, record.condition, record.replicate_id, record.role, noMeasurement ? "no raw measurement" : ""].filter(Boolean).join(" - ") : button.dataset.well;
  });
  const ordered = [...state.selectedWells].sort(sortWells);
  $("#selection-count").textContent = `${ordered.length} selected`; $("#selected-wells").textContent = ordered.length ? ordered.join(", ") : "Select wells on the plate";
  $("#assignment-panel").classList.toggle("inactive", !ordered.length); $("#apply-assignment").disabled = !ordered.length; $("#clear-assignment").disabled = !ordered.length;
  renderPlateSummary();
}

function renderPlateSummary() {
  const assigned = state.plateMap.filter(row => row.role);
  const counts = ["sample", "blank", "control", "unused"].map(role => [role, assigned.filter(row => row.role === role).length]);
  $("#plate-summary").innerHTML = `<strong>${assigned.length} / ${state.plateMap.length}</strong> wells assigned` + counts.map(([role, count]) => `<span><i class="legend-dot role-${role}"></i>${role}: ${count}</span>`).join("");
  $("#plate-preview-body").innerHTML = assigned.slice(0, 20).map(row => `<tr><td>${row.well}</td><td>${escapeHtml(row.sample_id)}</td><td>${escapeHtml(row.condition)}</td><td>${escapeHtml(row.replicate_id)}</td><td>${row.role}</td><td>${escapeHtml(row.blank_group)}</td></tr>`).join("") || '<tr><td colspan="6" class="empty-row">No metadata assigned yet.</td></tr>';
}

function openPlateMap() {
  $("#result-panel").hidden = true; $("#plate-panel").hidden = false; setWorkflowStep("map");
  configurePlateSizeSelector(); renderPlateMap(); window.scrollTo({ top: 0, behavior: "smooth" });
}

async function readMetadataFile(file) {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("Choose an .xlsx, .xls, or .csv metadata file.");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  if (!rawRows.length) throw new Error("The metadata file has no data rows.");
  const normalizedRows = rawRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase(), value])));
  const headers = new Set(Object.keys(normalizedRows[0]));
  const missing = METADATA_TEMPLATE_FIELDS.filter(field => !headers.has(field));
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}.`);
  return normalizedRows;
}

function showMetadataResult(message, type = "", errors = []) {
  const node = $("#metadata-status"); node.className = `metadata-status ${type}`;
  node.innerHTML = `<strong>${escapeHtml(message)}</strong>` + (errors.length ? `<ul>${errors.map(error => `<li>${escapeHtml(error.message)}</li>`).join("")}</ul>` : "");
}

function invalidateProcessedData() {
  state.processedMeasurements = [];
  state.processingSummary = null;
  $("#processing-result").hidden = true;
  invalidateParameterResults();
}

function selectedCorrectionMethod() {
  return document.querySelector('input[name="correction_method"]:checked').value;
}

function renderCorrectionValidation() {
  const method = selectedCorrectionMethod();
  const validation = validateBlankCorrection(state.result.rawMeasurements, state.plateMap, method);
  const node = $("#correction-messages");
  const blocks = [];
  if (validation.errors.length) blocks.push('<div class="validation-block errors"><strong>Resolve before processing</strong><ul>' + validation.errors.map(item => '<li>' + escapeHtml(item.message) + '</li>').join("") + '</ul></div>');
  if (validation.warnings.length) blocks.push('<div class="validation-block warnings"><strong>Warnings (you may continue)</strong><ul>' + validation.warnings.map(item => '<li>' + escapeHtml(item.message) + '</li>').join("") + '</ul></div>');
  if (!blocks.length) blocks.push('<div class="validation-block success"><strong>Ready for processing.</strong> Every sample/control blank group has matching blank wells.</div>');
  node.innerHTML = blocks.join("");
  $("#generate-processed").disabled = !validation.valid;
  $("#correction-method-note").textContent = method === "mean_blank_group"
    ? "At each time point, subtract the mean of matching blank wells from sample and control wells."
    : "Raw values will be copied to value_corrected without subtraction. Blank-group warnings are non-blocking.";
  return validation;
}

function openBlankCorrection() {
  $("#plate-panel").hidden = true;
  $("#correction-panel").hidden = false;
  setWorkflowStep("correct");
  invalidateProcessedData();
  renderCorrectionValidation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderProcessingResult(result) {
  const summary = result.summary;
  const fields = [["Samples",summary.samples],["Conditions",summary.conditions],["Replicate curves",summary.replicateCurves],["Sample wells",summary.sampleWells],["Control wells",summary.controlWells],["Blank wells used",summary.blankWells],["Time points",summary.timePoints],["Processed rows",summary.processedRows]];
  $("#processing-summary").innerHTML = fields.map(([label,value]) => '<div class="metric"><dt>'+escapeHtml(label)+'</dt><dd>'+escapeHtml(value)+'</dd></div>').join("");
  $("#processed-preview-body").innerHTML = result.processedMeasurements.slice(0,12).map(row => '<tr>' +
    ["time_h","well","sample_id","condition","replicate_id","role","blank_group","value_raw","blank_value","value_corrected"].map(field => '<td>'+escapeHtml(row[field])+'</td>').join("") + '</tr>').join("");
  $("#processing-result").hidden = false;
}

function getCheckedValues(selector) {
  return new Set([...document.querySelectorAll(selector + ":checked")].map(input => input.value));
}

function currentPlotRows() {
  const strains = getCheckedValues('#strain-filters input');
  const conditions = getCheckedValues('#condition-filters input');
  return state.processedMeasurements.filter(row => strains.has(row.sample_id || "") && conditions.has(row.condition || ""));
}

function checkboxList(values, name) {
  return values.map(value => '<label class="filter-check"><input type="checkbox" name="' + name + '" value="' + escapeHtml(value) + '" checked><span>' + escapeHtml(value || "(blank)") + '</span></label>').join("");
}

function initializePlotControls() {
  const strains = [...new Set(state.processedMeasurements.map(row => row.sample_id || ""))].sort();
  const conditions = [...new Set(state.processedMeasurements.map(row => row.condition || ""))].sort();
  $("#strain-filters").innerHTML = checkboxList(strains, "strain_filter");
  $("#condition-filters").innerHTML = checkboxList(conditions, "condition_filter");
  document.querySelectorAll(".plot-controls input,.plot-controls select").forEach(control => control.addEventListener("change", renderGrowthPlot));
}

function groupLabel(strain, condition) {
  return (strain || "Unnamed strain") + (condition ? " - " + condition : "");
}

function traceColor(index) {
  return ["#4fd1c5","#e8c66a","#a98df0","#69dfac","#ff8f70","#63a8ff","#f27db5","#a8c45f"][index % 8];
}

async function renderGrowthPlot() {
  if (!window.Plotly) { $("#plot-status").textContent = "Plotly did not load. Check your connection and refresh."; return; }
  const rows = currentPlotRows();
  const valueField = $("#plot-data").value === "raw" ? "value_raw" : "value_corrected";
  const display = $("#plot-display").value;
  const errorType = $("#plot-error").value;
  const traces = [];
  const groupKeys = [...new Set(rows.map(row => [row.sample_id || "",row.condition || ""].join("\u001f")))].sort();
  const colors = new Map(groupKeys.map((key,index)=>[key,traceColor(index)]));

  if (display !== "mean") {
    const replicates = new Map();
    rows.forEach(row => {
      const key = [row.sample_id || "",row.condition || "",row.well].join("\u001f");
      if (!replicates.has(key)) replicates.set(key,[]);
      replicates.get(key).push(row);
    });
    [...replicates.values()].forEach(curve => {
      curve.sort((a,b)=>a.elapsed_seconds-b.elapsed_seconds);
      const first=curve[0], groupKey=[first.sample_id || "",first.condition || ""].join("\u001f");
      traces.push({type:"scatter",mode:"lines",x:curve.map(r=>r.time_h),y:curve.map(r=>r[valueField]),name:groupLabel(first.sample_id,first.condition)+" / "+(first.replicate_id || first.well),legendgroup:groupKey,showlegend:display==="replicates",line:{color:colors.get(groupKey),width:1},opacity:.48,customdata:curve.map(r=>[first.sample_id,first.condition,first.replicate_id,first.well]),hovertemplate:"Strain: %{customdata[0]}<br>Condition: %{customdata[1]}<br>Replicate: %{customdata[2]}<br>Well: %{customdata[3]}<br>Time: %{x:.3f} h<br>Value: %{y:.4f}<extra></extra>"});
    });
  }

  const summary = summarizeProcessedMeasurements(rows,valueField);
  state.plotSummary = summary;
  if (display !== "replicates") {
    const grouped = new Map();
    summary.forEach(row => {
      const key=[row.strain,row.condition].join("\u001f"); if(!grouped.has(key))grouped.set(key,[]); grouped.get(key).push(row);
    });
    grouped.forEach((curve,key)=>{
      curve.sort((a,b)=>a.time_h-b.time_h);
      const errorArray = curve.map(row => errorType==="sd"?row.sd:errorType==="sem"?row.sem:errorType==="ci95"?(row.ci95_upper==null?null:row.ci95_upper-row.mean):0);
      traces.push({type:"scatter",mode:"lines",x:curve.map(r=>r.time_h),y:curve.map(r=>r.mean),name:groupLabel(curve[0].strain,curve[0].condition),legendgroup:key,line:{color:colors.get(key),width:3},error_y:{type:"data",array:errorArray,visible:errorType!=="none",color:colors.get(key),thickness:1,width:2},customdata:curve.map(r=>[r.strain,r.condition,r.n,r.sd,r.sem,r.ci95_lower,r.ci95_upper]),hovertemplate:"Strain: %{customdata[0]}<br>Condition: %{customdata[1]}<br>Time: %{x:.3f} h<br>Mean: %{y:.4f}<br>n: %{customdata[2]}<br>SD: %{customdata[3]:.4f}<br>SEM: %{customdata[4]:.4f}<br>95% CI: [%{customdata[5]:.4f}, %{customdata[6]:.4f}]<extra></extra>"});
    });
  }

  const yTitle = state.result?.summary?.unit === "unknown" ? "Measurement" : state.result.summary.unit;
  const layout={paper_bgcolor:"#141b26",plot_bgcolor:"#0e141d",font:{family:"Space Grotesk, sans-serif",color:"#d4dae3"},margin:{l:70,r:25,t:35,b:60},xaxis:{title:"Time (h)",gridcolor:"#1f2a38",zerolinecolor:"#1f2a38"},yaxis:{title:yTitle,type:$("#plot-y-axis").value,gridcolor:"#1f2a38",zerolinecolor:"#1f2a38"},legend:{orientation:"h",y:-.22},hovermode:"closest"};
  await Plotly.react("growth-plot",traces,layout,{responsive:true,displaylogo:false,scrollZoom:true,modeBarButtonsToRemove:["select2d","lasso2d"]});
  const nonPositive = $("#plot-y-axis").value==="log" ? rows.filter(row=>!(row[valueField]>0)).length : 0;
  $("#plot-status").textContent = traces.length ? (nonPositive ? nonPositive+" non-positive values are hidden on the log axis." : summary.length+" summary points; hover to inspect n and uncertainty.") : "No curves match the selected filters.";
}

function openPlotPanel() {
  $("#correction-panel").hidden=true; $("#plot-panel").hidden=false; setWorkflowStep("plot");
  initializePlotControls(); renderGrowthPlot(); window.scrollTo({top:0,behavior:"smooth"});
}

function invalidateParameterResults() {
  state.parameterRows = [];
  state.parameterSummary = [];
  const results = $("#parameter-results");
  if (results) results.hidden = true;
}

function parameterValue(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function setParameterStage(stage, status, detail) {
  const row = document.querySelector('[data-parameter-stage="' + stage + '"]');
  if (!row) return;
  row.dataset.state = status;
  row.querySelector("b").textContent = status === "done" ? "✓" : status === "error" ? "!" : status === "loading" ? "…" : "○";
  row.querySelector("small").textContent = detail;
}

function resetParameterStages() {
  ["runtime","package","data","analysis"].forEach(stage => setParameterStage(stage, "idle", "Waiting"));
  $("#parameter-error").hidden = true;
}

function openParameterPanel() {
  $("#plot-panel").hidden = true;
  $("#parameter-panel").hidden = false;
  setWorkflowStep("parameters");
  const eligible = eligibleParameterMeasurements(state.processedMeasurements);
  const curves = new Set(eligible.map(row => row.well));
  $("#parameter-eligibility").textContent = curves.size + " eligible sample/control replicate curves · " + eligible.length.toLocaleString() + " measurements. Blank and unused wells are excluded.";
  $("#parameter-methods-text").innerHTML = parameterMethodsSentences().map(sentence => "<li>" + escapeHtml(sentence) + "</li>").join("");
  $("#parameter-citation").textContent = "Citation: " + GCPLYR_CITATION;
  $("#parameter-engine-version").textContent = "gcplyr " + GCPLYR_VERSION + " in webR " + WEBR_VERSION;
  $("#parameter-settings").innerHTML = [
    ["Input", PARAMETER_SETTINGS.input],
    ["Smoothing", PARAMETER_SETTINGS.smoothing],
    ["Growth rate", PARAMETER_SETTINGS.derivative],
    ["Lag time", PARAMETER_SETTINGS.lagTime],
    ["Max OD", PARAMETER_SETTINGS.maximum],
    ["AUC", PARAMETER_SETTINGS.auc],
    ["Package pin", "gcplyr " + GCPLYR_VERSION + " artifact · SHA-256 " + GCPLYR_ARTIFACT_SHA256.slice(0, 12) + "…"]
  ].map(([label,value]) => '<div><dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd></div>').join("");
  resetParameterStages();
  window.scrollTo({top:0,behavior:"smooth"});
}

function renderParameterResults() {
  const failed = state.parameterRows.filter(row => row.analysis_status === "error");
  const warned = state.parameterRows.filter(row => row.analysis_status === "warning");
  const completed = state.parameterRows.length - failed.length;
  $("#parameter-result-note").textContent = completed + " curves completed" + (warned.length ? "; " + warned.length + " have QC warnings" : "") + (failed.length ? "; " + failed.length + " returned errors" : "") + ". Warning curves remain included in parameter summaries.";
  $("#parameter-replicate-body").innerHTML = state.parameterRows.map(row => '<tr class="' + (row.analysis_status === "error" ? "parameter-error-row" : row.analysis_status === "warning" ? "parameter-warning-row" : "") + '">' +
    ["well","strain","condition","replicate_id","role"].map(field => '<td>' + escapeHtml(row[field]) + '</td>').join("") +
    '<td>' + parameterValue(row.max_growth_rate_per_h) + '</td><td>' + parameterValue(row.doubling_time_h) + '</td><td>' + parameterValue(row.lag_time_h) + '</td><td>' + parameterValue(row.max_od) + '</td><td>' + parameterValue(row.auc_od_h) + '</td><td>' + escapeHtml(row.analysis_status) + (row.analysis_message ? ': ' + escapeHtml(row.analysis_message) : "") + '</td></tr>'
  ).join("");
  $("#parameter-summary-body").innerHTML = state.parameterSummary.map(row => '<tr>' +
    ["strain","condition","parameter","unit"].map(field => '<td>' + escapeHtml(row[field]) + '</td>').join("") +
    '<td>' + parameterValue(row.mean) + '</td><td>' + parameterValue(row.sd) + '</td><td>' + parameterValue(row.sem) + '</td><td>' + parameterValue(row.ci95_lower) + '</td><td>' + parameterValue(row.ci95_upper) + '</td><td>' + row.n + '</td></tr>'
  ).join("");
  $("#parameter-results").hidden = false;
}

async function runParameterAnalysis() {
  const button = $("#run-parameters");
  button.disabled = true;
  button.textContent = "Running gcplyr analysis…";
  invalidateParameterResults();
  resetParameterStages();
  try {
    const result = await runGcplyrParameters(state.processedMeasurements, setParameterStage);
    state.parameterRows = result.rows;
    state.parameterSummary = summarizeParameters(result.rows);
    renderParameterResults();
  } catch (error) {
    const active = ["runtime","package","data","analysis"].find(stage => document.querySelector('[data-parameter-stage="' + stage + '"]').dataset.state === "loading");
    if (active) setParameterStage(active, "error", "Failed");
    $("#parameter-error-message").textContent = error?.stack || error?.message || String(error);
    $("#parameter-error").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Run gcplyr parameter analysis";
  }
}

async function copyMethodsText() {
  const text = parameterMethodsText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
  }
  const button = $("#copy-methods");
  button.textContent = "Methods text copied";
  window.setTimeout(() => { button.textContent = "Copy Methods Text"; }, 1800);
}

const dropzone = $("#dropzone"), input = $("#file-input");
dropzone.addEventListener("click", event => { if (event.target.tagName !== "INPUT") input.click(); });
dropzone.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") input.click(); });
input.addEventListener("change", () => handleFile(input.files[0]));
["dragenter", "dragover"].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add("dragging"); }));
["dragleave", "drop"].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
dropzone.addEventListener("drop", event => handleFile(event.dataTransfer.files[0]));

$("#reset-button").addEventListener("click", () => {
  Object.assign(state, { result: null, fileName: "", plateMap: [], plateSize: 96, measuredWells: new Set(), processedMeasurements: [], processingSummary: null, experimentName: "growth_curve", plotSummary: [], parameterRows: [], parameterSummary: [] }); state.selectedWells.clear(); input.value = "";
  $("#result-panel").hidden = true; $("#plate-panel").hidden = true; $("#correction-panel").hidden = true; $("#plot-panel").hidden = true; $("#parameter-panel").hidden = true; $("#upload-panel").hidden = false; $("#manual-format").hidden = true; setStatus(""); setWorkflowStep("upload");
});
$("#download-button").addEventListener("click", () => downloadText(toCsv(state.result.rawMeasurements), dataFilename("raw_standardized")));
$("#continue-button").addEventListener("click", openPlateMap);
$("#back-to-summary").addEventListener("click", () => { $("#plate-panel").hidden = true; $("#result-panel").hidden = false; setWorkflowStep("standardize"); });
$("#select-all").addEventListener("click", () => selectWells(state.plateMap.map(row => row.well)));
$("#clear-selection").addEventListener("click", () => { state.selectedWells.clear(); renderPlateSelection(); });

$("#plate-size").addEventListener("change", event => {
  const nextSize = Number(event.target.value);
  const outsideAssignments = state.plateMap.filter(row => row.role && !layoutContainsWell(nextSize, row.well));
  if (outsideAssignments.length && !window.confirm(`Changing layout will remove metadata from ${outsideAssignments.length} wells outside the new layout. Continue?`)) { event.target.value = String(state.plateSize); return; }
  state.plateSize = nextSize; state.plateMap = resizePlateMap(state.plateMap, nextSize); state.selectedWells.clear();
  $("#plate-size-note").textContent = "Layout selected manually."; showMetadataResult(""); renderPlateMap();
});

$("#assignment-form").addEventListener("submit", event => {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  state.plateMap = assignPlateMetadata(state.plateMap, [...state.selectedWells], { sample_id: form.get("sample_id").trim(), condition: form.get("condition").trim(), role: form.get("role"), blank_group: form.get("blank_group").trim(), replicate_id: form.get("replicate_id").trim() }, form.get("auto_replicates") === "on");
  renderPlateMap();
});
$("#clear-assignment").addEventListener("click", () => { state.plateMap = clearPlateAssignments(state.plateMap, [...state.selectedWells]); renderPlateMap(); });
$("#download-plate-map").addEventListener("click", () => downloadText(plateMapToCsv(state.plateMap), dataFilename("plate_map")));
$("#download-metadata-template-xlsx").addEventListener("click", async () => {
  try { await downloadExcelMetadataTemplate(); showMetadataResult("Excel template downloaded.", "success"); }
  catch (error) { showMetadataResult(error.message, "error"); }
});
$("#download-metadata-template-csv").addEventListener("click", () => {
  downloadText(metadataTemplateCsv(state.plateSize), buildMetadataTemplateFilename(state.experimentName, "csv"));
  showMetadataResult("CSV template downloaded. Role values will still be validated during import.", "success");
});
$("#choose-metadata").addEventListener("click", () => $("#metadata-file").click());

$("#continue-blank-correction").addEventListener("click", openBlankCorrection);
$("#back-to-plate-map").addEventListener("click", () => {
  $("#correction-panel").hidden = true; $("#plate-panel").hidden = false; setWorkflowStep("map");
});
document.querySelectorAll('input[name="correction_method"]').forEach(input => input.addEventListener("change", () => {
  invalidateProcessedData(); renderCorrectionValidation();
}));
$("#generate-processed").addEventListener("click", () => {
  const result = generateProcessedMeasurements(state.result.rawMeasurements, state.plateMap, selectedCorrectionMethod());
  if (!result.valid) { renderCorrectionValidation(); return; }
  state.processedMeasurements = result.processedMeasurements;
  state.processingSummary = result.summary;
  renderProcessingResult(result);
});
$("#download-processed").addEventListener("click", () => {
  downloadText(processedMeasurementsToCsv(state.processedMeasurements), dataFilename("processed"));
});


$("#continue-to-plot").addEventListener("click", openPlotPanel);
$("#back-to-processing").addEventListener("click",()=>{$("#plot-panel").hidden=true;$("#correction-panel").hidden=false;setWorkflowStep("correct");});
$("#download-summary").addEventListener("click",()=>downloadText(summaryToCsv(state.plotSummary),dataFilename("summary","csv")));
async function exportTransparentPlot(format, width, height) {
  const plot = document.getElementById("growth-plot");
  if (!window.Plotly || !plot?.layout) return;
  const exportTheme = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    "font.color": "#111827",
    "xaxis.color": "#111827",
    "xaxis.gridcolor": "rgba(17,24,39,0.18)",
    "xaxis.zerolinecolor": "rgba(17,24,39,0.35)",
    "yaxis.color": "#111827",
    "yaxis.gridcolor": "rgba(17,24,39,0.18)",
    "yaxis.zerolinecolor": "rgba(17,24,39,0.35)"
  };
  const screenTheme = {
    paper_bgcolor: "#141b26",
    plot_bgcolor: "#0e141d",
    "font.color": "#d4dae3",
    "xaxis.color": "#d4dae3",
    "xaxis.gridcolor": "#1f2a38",
    "xaxis.zerolinecolor": "#1f2a38",
    "yaxis.color": "#d4dae3",
    "yaxis.gridcolor": "#1f2a38",
    "yaxis.zerolinecolor": "#1f2a38"
  };
  try {
    await Plotly.relayout(plot, exportTheme);
    await Plotly.downloadImage(plot, {
      format,
      width,
      height,
      filename: buildPlotFilename(state.experimentName, format).replace(new RegExp("\\." + format + "$"), "")
    });
  } finally {
    await Plotly.relayout(plot, screenTheme);
  }
}

$("#export-plot-png").addEventListener("click", () => exportTransparentPlot("png", 1400, 900));
$("#export-plot-svg").addEventListener("click", () => exportTransparentPlot("svg", 1200, 800));
$("#continue-to-parameters").addEventListener("click", openParameterPanel);
$("#back-to-plot").addEventListener("click",()=>{$("#parameter-panel").hidden=true;$("#plot-panel").hidden=false;setWorkflowStep("plot");});
$("#run-parameters").addEventListener("click", runParameterAnalysis);
$("#download-parameter-replicates").addEventListener("click",()=>downloadText(rowsToCsv(state.parameterRows,REPLICATE_PARAMETER_FIELDS),buildParameterFilename(state.experimentName,"replicates")));
$("#download-parameter-summary").addEventListener("click",()=>downloadText(rowsToCsv(state.parameterSummary,SUMMARY_PARAMETER_FIELDS),buildParameterFilename(state.experimentName,"summary")));
$("#copy-methods").addEventListener("click", copyMethodsText);
$("#experiment-name").addEventListener("input",event=>{state.experimentName=event.target.value||"growth_curve";$("#experiment-filename-preview").textContent=sanitizeExperimentName(state.experimentName);});

$("#metadata-file").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  showMetadataResult(`Reading ${file.name} locally...`, "working");
  try {
    const rows = await readMetadataFile(file);
    const result = importPlateMetadata(state.plateMap, rows, state.plateSize);
    if (!result.valid) { showMetadataResult("Metadata was not imported. Fix these validation errors:", "error", result.errors); return; }
    state.plateMap = result.plateMap; renderPlateMap();
    showMetadataResult(`Imported metadata for ${result.rows.length} wells. Review and edit it on the plate before continuing.`, "success");
  } catch (error) { showMetadataResult(error.message, "error"); }
  finally { event.target.value = ""; }
});
