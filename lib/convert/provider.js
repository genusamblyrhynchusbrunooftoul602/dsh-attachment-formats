/**
 * dsh-attachment-formats — 转换引擎探测（host side，v3）。
 *
 * 引擎优先级（env 可覆盖）：
 *   DSH_ATTACH_ENGINE=auto|python|builtin   PDF 文本层引擎
 *   DSH_ATTACH_OCR=auto|baidu|tesseract-js|off  扫描件 OCR 引擎（baidu 见 ocr-baidu.js）
 *
 * `python` 引擎 = 项目内 venv（.venv/Scripts/python.exe）+ pymupdf4llm；
 * 探测结果带 TTL 缓存，缺失时自动回退 builtin（pdfjs 文字层）。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENV_PYTHON = join(PROJECT_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
export const PY_SCRIPT = join(PROJECT_DIR, "lib", "py", "pymupdf4llm_convert.py");

const PROBE_TTL_MS = 5 * 60 * 1000;
let pythonProbe = { at: 0, available: false };

/** 探测 venv python + pymupdf4llm 是否可用（TTL 5 分钟缓存失败与成功）。 */
export async function probePythonEngine() {
  const now = Date.now();
  if (now - pythonProbe.at < PROBE_TTL_MS) return pythonProbe.available;
  pythonProbe = { at: now, available: false };
  if (!existsSync(VENV_PYTHON) || !existsSync(PY_SCRIPT)) return false;
  try {
    const { spawn } = await import("node:child_process");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(VENV_PYTHON, ["-c", "import pymupdf4llm, pymupdf"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 30_000
      });
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? 1));
    });
    pythonProbe.available = code === 0;
  } catch {
    pythonProbe.available = false;
  }
  return pythonProbe.available;
}

/** 读取引擎配置（每次请求时读取，允许运行时切换）。 */
export function enginePolicy() {
  const engine = (process.env.DSH_ATTACH_ENGINE ?? "auto").toLowerCase();
  const ocr = (process.env.DSH_ATTACH_OCR ?? "auto").toLowerCase();
  const baidu = {
    apiKey: (process.env.BAIDU_OCR_API_KEY ?? "").trim(),
    secretKey: (process.env.BAIDU_OCR_SECRET ?? "").trim(),
    accurate: process.env.DSH_ATTACH_OCR_ACCURATE === "1"
  };
  const vlm = {
    base: (process.env.DSH_ATTACH_VLM_BASE ?? "").trim(),
    key: (process.env.DSH_ATTACH_VLM_KEY ?? "").trim(),
    model: (process.env.DSH_ATTACH_VLM_MODEL ?? "").trim(),
    configured: (process.env.DSH_ATTACH_VLM_BASE ?? "").trim() !== "" && (process.env.DSH_ATTACH_VLM_MODEL ?? "").trim() !== ""
  };
  const docServer = (process.env.DSH_ATTACH_DOC_SERVER ?? "").trim();
  const ocrPolicy = ocr === "tesseract-js" || ocr === "baidu" || ocr === "vlm" || ocr === "off" ? ocr : "auto";
  return {
    engine: engine === "builtin" || engine === "python" ? engine : "auto",
    ocr: ocrPolicy,
    baidu,
    vlm,
    docServer: docServer === "" ? null : docServer
  };
}

/**
 * 运行 venv 内的 PDF 转换脚本。
 * @param {Buffer} pdfBytes - 编码 PDF。
 * @returns {Promise<{ok:true, engine:string, pages:string[], pageCount:number, hasTextLayer:boolean, toc?: Array<[number,string,number]>} | {ok:false, error:string}>}
 */
export async function runPythonPdf(pdfBytes) {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const dir = mkdtempSync(pathJoin(tmpdir(), "dsh-attach-py-"));
  const pdfPath = pathJoin(dir, "input.pdf");
  const outPath = pathJoin(dir, "result.json");
  writeFileSync(pdfPath, pdfBytes);
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(VENV_PYTHON, [PY_SCRIPT, pdfPath, outPath], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 180_000
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exit !== 0) return { ok: false, error: `python engine exited with code ${exit}` };
    const raw = readFileSync(outPath, "utf8");
    const result = JSON.parse(raw);
    if (result.ok !== true) return { ok: false, error: result.error ?? "python engine failed" };
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---- 外部二进制探测（P0：pandoc / LibreOffice）--------------------------

/** 探针缓存（TTL 10 分钟，与 python 探测同思路）。 */
const binProbes = new Map();
async function probeBinary(key, candidates, ttlMs = 10 * 60 * 1000) {
  const cached = binProbes.get(key);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < ttlMs) return cached.path;
  let found = null;
  for (const candidate of candidates) {
    const executable = candidate();
    if (executable === null) continue;
    try {
      const { spawn } = await import("node:child_process");
      const ok = await new Promise((resolve) => {
        const child = spawn(executable.path, executable.args, {
          windowsHide: true,
          stdio: "ignore",
          timeout: 20_000
        });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0 || code === 1)); // --version 正常退出码 0
      });
      if (ok) {
        found = executable;
        break;
      }
    } catch {
      /* 下一个候选 */
    }
  }
  binProbes.set(key, { at: now, path: found });
  return found;
}

/** 探测 pandoc（PATH 优先）。 */
export async function probePandoc() {
  return probeBinary("pandoc", [() => ({ path: "pandoc", args: ["--version"] })]);
}

/** 探测 LibreOffice soffice（PATH + Windows 常见安装路径）。 */
export function libreOfficeCandidates() {
  const candidates = [];
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA
  ].filter((root) => typeof root === "string" && root !== "");
  for (const root of roots) {
    candidates.push(() => {
      const path = join(root, "LibreOffice", "program", "soffice.exe");
      return existsSync(path) ? { path, args: ["--version"] } : null;
    });
  }
  candidates.push(() => ({ path: "soffice", args: ["--version"] }));
  return candidates;
}
export async function probeLibreOffice() {
  return probeBinary("soffice", libreOfficeCandidates());
}
