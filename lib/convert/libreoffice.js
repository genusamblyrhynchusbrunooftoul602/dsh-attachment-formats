/**
 * dsh-attachment-formats — 旧版 Office 转换（host side，v0.6 P0）。
 *
 * .doc / .xls / .ppt 经 LibreOffice headless 转为 docx/xlsx/pptx，再走
 * 现有 office 提取管线。每次转换使用独立 UserInstallation 目录，避免
 * soffice 实例间 profile 锁冲突。
 */
import { createHash } from "node:crypto";

const FROM_TO = {
  doc: "docx",
  xls: "xlsx",
  ppt: "pptx"
};

/**
 * 用 LibreOffice headless 转换旧版 Office 文件。
 * @param {Buffer} bytes - 源文件字节。
 * @param {"doc"|"xls"|"ppt"} from - 源格式。
 * @param {string} sofficePath - 探测到的 soffice 可执行文件路径。
 * @returns {Promise<{ data: Buffer, format: "docx"|"xlsx"|"pptx" }>}
 */
export async function libreOfficeConvert(bytes, from, sofficePath) {
  const to = FROM_TO[from];
  if (to === undefined) throw new Error(`不支持的旧版格式: ${from}`);
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(pathJoin(tmpdir(), "dsh-attach-lo-"));
  const input = pathJoin(dir, `input.${from}`);
  const outDir = pathJoin(dir, "out");
  writeFileSync(input, bytes);
  const profile = pathJoin(dir, "profile");
  try {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn(sofficePath, [
        "-env:UserInstallation=" + pathToFileURL(profile).href,
        "--headless",
        "--convert-to", to,
        "--outdir", outDir,
        input
      ], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 180_000
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    if (exit !== 0) throw new Error(`LibreOffice exited with code ${exit}`);
    const output = pathJoin(outDir, `input.${to}`);
    return { data: readFileSync(output), format: to };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 内容寻址的临时标记（保留给未来缓存复用；当前每次独立转换）。 */
export function legacyHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}
