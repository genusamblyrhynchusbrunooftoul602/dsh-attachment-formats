/**
 * dsh-attachment-formats — 扫描件 OCR（host side，v3）。
 *
 * tesseract.js（纯 JS/WASM，无原生依赖）逐页识别渲染出的页面图。
 * traineddata 首次使用时下载到插件目录 vendor/tessdata（gzip 缓存），
 * 镜像按 jsdelivr → projectnaptha 顺序回退；下载失败时 OCR 不可用，
 * 调用方回退到"页面图（仅视觉模型）"路径。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TESSDATA_DIR = join(PROJECT_DIR, "vendor", "tessdata");

/** OCR 语言：英文 + 简体中文（best 精度档）。 */
const LANGS = ["eng", "chi_sim"];
/** 单次 OCR 的最大页数（tesseract.js 每页约 1-4s，控制单请求时延）。 */
export const OCR_PAGE_CAP = 20;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const MIRRORS = [
  "https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_best/{lang}.traineddata.gz",
  "https://tessdata.projectnaptha.com/4.0.0_best/{lang}.traineddata.gz",
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/{lang}/4.0.0_best_int/{lang}.traineddata.gz"
];

/** 下载（或复用缓存）某个语言的 traineddata；失败返回 false。 */
export async function ensureTraineddata(lang) {
  const target = join(TESSDATA_DIR, `${lang}.traineddata.gz`);
  try {
    if (existsSync(target) && statSync(target).size > 100_000) return true;
    mkdirSync(TESSDATA_DIR, { recursive: true });
    for (const mirror of MIRRORS) {
      const url = mirror.replace("{lang}", lang);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok || response.body === null) continue;
        const temp = `${target}.part`;
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
        const info = statSync(temp);
        if (info.size < 100_000) continue; // 太小视为失败
        const { renameSync } = await import("node:fs");
        renameSync(temp, target);
        return true;
      } catch {
        /* 下一个镜像 */
      }
    }
    return false;
  } catch {
    return false;
  }
}

let workerPromise = null;

/** 终止常驻 worker（服务进程退出/测试收尾用；之后再次 OCR 会重建）。 */
export async function disposeOcr() {
  const pending = workerPromise;
  workerPromise = null;
  if (pending === null) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* worker 已不可用 */
  }
}

/** 取一个（复用）tesseract worker；语言就绪且缓存可用时返回。 */
async function acquireWorker() {
  if (workerPromise !== null) return workerPromise;
  workerPromise = (async () => {
    for (const lang of LANGS) {
      const ok = await ensureTraineddata(lang);
      if (!ok) throw new Error(`OCR 语言包下载失败（${lang}），请检查网络后重试`);
    }
    const { createWorker } = await import("tesseract.js");
    return createWorker(LANGS, 1, {
      langPath: TESSDATA_DIR,
      cachePath: TESSDATA_DIR,
      cacheMethod: "readOnly"
    });
  })().catch((error) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

/**
 * 对渲染出的页面图逐页 OCR，返回带页码标记的纯文本。
 * @param {Array<{ data: Uint8Array }>} pages - 已渲染页面（PNG/JPEG 字节）。
 * @param {{ onPage?: (index: number, total: number, chars: number) => void }} [hooks]
 * @returns {Promise<{ text: string, pages: number, chars: number, confidence: number }>}
 */
export async function ocrPages(pages, hooks = {}) {
  const worker = await acquireWorker();
  const sections = [];
  let chars = 0;
  let confidences = 0;
  let words = 0;
  let index = 0;
  for (const page of pages) {
    const { data } = await worker.recognize(Buffer.from(page.data));
    const text = String(data?.text ?? "").trim();
    chars += text.length;
    if (typeof data?.confidence === "number") {
      const count = Array.isArray(data.words) ? data.words.length : 1;
      confidences += data.confidence * count;
      words += count;
    }
    if (text !== "") sections.push(`<!-- p${index + 1} -->\n${text}`);
    index += 1;
    hooks.onPage?.(index, pages.length, chars);
  }
  return {
    text: sections.join("\n\n"),
    pages: pages.length,
    chars,
    confidence: words > 0 ? confidences / words : 0
  };
}
