import {
  WEBR_MODULE_URL, WEBR_VERSION, GCPLYR_VERSION, WEBR_PACKAGE_REPOSITORY,
  GCPLYR_ARTIFACT_URL, GCPLYR_ARTIFACT_SHA256, GCPLYR_RUNTIME_DEPENDENCIES
} from "./webr-gcplyr-config.js";
import { eligibleParameterMeasurements, parameterInputToCsv, gcplyrParameterScript, parseParameterCsv } from "./parameters-core.js";

let runtimePromise;

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function tarText(bytes) {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero === -1 ? bytes : bytes.subarray(0, zero));
}

async function ensureDirectory(webR, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    try { await webR.FS.mkdir(current); } catch { /* Directory already exists. */ }
  }
}

async function extractTgzToLibrary(webR, artifact) {
  const stream = new Blob([artifact]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const libraryPath = await webR.evalRString(".libPaths()[1]");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const relativePath = (prefix ? prefix + "/" : "") + name;
    const size = Number.parseInt(tarText(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error("Unsafe path in pinned gcplyr artifact.");
    }
    const target = libraryPath + "/" + relativePath.replace(/\/$/, "");
    if (type === "5") {
      await ensureDirectory(webR, target);
    } else if (type === "0" || type === "\0") {
      await ensureDirectory(webR, target.slice(0, target.lastIndexOf("/")));
      await webR.FS.writeFile(target, tar.slice(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

async function installPinnedGcplyr(webR) {
  await webR.installPackages(GCPLYR_RUNTIME_DEPENDENCIES, { repos: WEBR_PACKAGE_REPOSITORY });
  const response = await fetch(GCPLYR_ARTIFACT_URL);
  if (!response.ok) throw new Error(`Unable to download pinned gcplyr artifact (HTTP ${response.status}).`);
  const artifact = new Uint8Array(await response.arrayBuffer());
  const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", artifact)));
  if (digest !== GCPLYR_ARTIFACT_SHA256) {
    throw new Error(`Pinned gcplyr artifact checksum mismatch: expected ${GCPLYR_ARTIFACT_SHA256}, received ${digest}.`);
  }
  await extractTgzToLibrary(webR, artifact);
}

async function createRuntime(onStage) {
  onStage("runtime", "loading", `Downloading webR ${WEBR_VERSION}`);
  const { WebR, ChannelType } = await import(WEBR_MODULE_URL);
  const webR = new WebR({ interactive: false, channelType: ChannelType.PostMessage });
  await webR.init();
  onStage("runtime", "done", `webR ${WEBR_VERSION} · PostMessage`);
  onStage("package", "loading", `Loading checksum-pinned gcplyr ${GCPLYR_VERSION} and dependencies`);
  await installPinnedGcplyr(webR);
  const actualVersion = await webR.evalRString('as.character(packageVersion("gcplyr"))');
  if (actualVersion !== GCPLYR_VERSION) {
    await webR.close();
    throw new Error(`Pinned gcplyr version mismatch: expected ${GCPLYR_VERSION}, received ${actualVersion}`);
  }
  onStage("package", "done", `gcplyr ${actualVersion}`);
  return webR;
}

async function getRuntime(onStage) {
  if (!runtimePromise) runtimePromise = createRuntime(onStage).catch(error => { runtimePromise = null; throw error; });
  const runtime = await runtimePromise;
  onStage("runtime", "done", `webR ${WEBR_VERSION} · PostMessage`);
  onStage("package", "done", `gcplyr ${GCPLYR_VERSION}`);
  return runtime;
}

export async function runGcplyrParameters(processedMeasurements, onStage = () => {}) {
  const eligible = eligibleParameterMeasurements(processedMeasurements);
  if (!eligible.length) throw new Error("No eligible sample or control measurements are available for parameter analysis.");
  const webR = await getRuntime(onStage);
  onStage("data", "loading", "Copying processed measurements into browser-side R memory");
  await webR.FS.writeFile("/tmp/processed_measurements.csv", new TextEncoder().encode(parameterInputToCsv(eligible)));
  onStage("data", "done", `${eligible.length.toLocaleString()} rows · no upload`);
  onStage("analysis", "loading", "Calculating replicate-level growth parameters");
  await webR.evalRVoid(gcplyrParameterScript());
  const bytes = await webR.FS.readFile("/tmp/gcplyr_parameter_results.csv");
  const rows = parseParameterCsv(new TextDecoder().decode(bytes));
  onStage("analysis", "done", `${rows.length} replicate curves analysed`);
  return { rows, eligibleMeasurements: eligible.length, gcplyrVersion: GCPLYR_VERSION, webRVersion: WEBR_VERSION };
}
