/**
 * dsh-attachment-formats — 转换引擎探测（host side，v3）。
 *
 * 引擎优先级（env 可覆盖）：
 *   DSH_ATTACH_ENGINE=auto|python|builtin   PDF 文本层引擎
 *   DSH_ATTACH_OCR=auto|tesseract-js|off   扫描件 OCR 引擎
 *
 * `python` 引擎 = 项目内 venv（.venv/Scripts/python.exe）+ pymupdf4llm；
 * 探测结果带 TTL 缓存，缺失时自动回退 builtin（pdfjs 文字层）。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
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
  return {
    engine: engine === "builtin" || engine === "python" ? engine : "auto",
    ocr: ocr === "tesseract-js" || ocr === "off" ? ocr : "auto"
  };
}

/**
 * 运行 venv 内的 PDF 转换脚本。
 * @param {Buffer} pdfBytes - 编码 PDF。
 * @returns {Promise<{ok:true, engine:string, pages:string[], pageCount:number, hasTextLayer:boolean} | {ok:false, error:string}>}
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
