/**
 * dsh-attachment-formats — host half.
 *
 * POST /api/attach-formats/convert
 *
 *   body: {
 *     cwd: "<会话工作区绝对路径>",          // 可选；决定缓存落盘位置
 *     sessionId: "<会话 id>",              // 可选；仅记录
 *     files: [
 *       { name: "报告.pdf", kind: "pdf", data: "<base64>" },
 *       { name: "长文档.md", kind: "text-cache", data: "<base64>" },
 *       ...
 *     ]
 *   }
 *
 *   resp: { ok: true, results: [ <result> ] }，result 三种形态：
 *
 *   - { input, kind: "images", images: [...], warnings: [...] }
 *     图片结果（扫描件无 OCR 时的回退），沿用 v1 语义；
 *   - { input, kind: "text", text }
 *     文本结果（≤ 直插阈值），客户端直接注入草稿；
 *   - { input, kind: "index", card, docPath, pageCount, lineCount, charCount }
 *     大型文档：文本已落盘工作区 .dsh-attachments/<sha-8>/doc.md（+ 页面 PNG
 *     与 manifest.json、聚合 INDEX.md），card 为注入草稿的索引卡。
 *
 * 引擎（v3，env 可覆盖，见 convert/provider.js）：
 *   PDF 文本层：auto → python(pymupdf4llm，venv 可用时) → builtin(pdfjs)；
 *   扫描件 OCR：python(PyMuPDF+tesseract) → tesseract.js → 页面图回退。
 *
 * v2b：
 *   - `/attach list` 列出已转存文档；`/attach full <id|名称>` 把全文作为
 *     next-step 收件箱消息并入模型上下文（用户下一条消息生效）；
 *   - `directLimitChars`：客户端按 token-meter 上下文余量计算的直插上限，
 *     主机端用 min(8 万, 该值) 分流，杜绝直插顶爆上下文被 API 静默截尾。
 */
import { probePdfPageCount, renderPdfPages } from "./convert/pdf.js";
import { extractPdfText } from "./convert/pdftext.js";
import { docxToText } from "./convert/docx.js";
import { xlsxToText } from "./convert/xlsx.js";
import { pptxToText } from "./convert/pptx.js";
import { jsonTree, mdOutline } from "./convert/outline.js";
import { enginePolicy, probeLibreOffice, probePandoc, probePythonEngine, runPythonPdf } from "./convert/provider.js";
import { ocrPages, OCR_PAGE_CAP } from "./convert/ocr.js";
import { baiduOcrPages } from "./convert/ocr-baidu.js";
import { vlmOcrPages } from "./convert/ocr-vlm.js";
import { docServerConvert } from "./convert/doc-server.js";
import sharp from "sharp";
import { tiffToPngPages } from "./convert/tiff.js";
import { convertPandocFormat } from "./convert/pandoc.js";
import { libreOfficeConvert } from "./convert/libreoffice.js";
import {
  cacheSize, cleanupCache, clearCache, listCachedDocs, readCachedDoc,
  removeCachedDocs, resolveCacheRoot, resolveWorkspaceFile, shortHashOf, writeCache
} from "./cache.js";
import {
  b64decode, b64encode, baseNameOf, extensionOf,
  FALLBACK_IMAGE_LIMITS, imageLimitsOf, MAX_FILE_BYTES, sniffKind
} from "./convert/util.js";

const name = "dsh-attachment-formats";
const inject = ["webServer", "commands"];

const ROUTE_PATH = "/api/attach-formats/convert";
/** Hard cap on the JSON request body (base64 inflates raw bytes by ~4/3). */
const MAX_BODY_BYTES = 160 * 1024 * 1024;
/** 直插草稿的文本上限；超过则走索引卡模式（v2b：上下文余量可进一步压低）。 */
const DIRECT_TEXT_CHARS = 80_000;
/** directLimitChars 的合法下界（过低一律视为无效，回退默认）。 */
const DIRECT_LIMIT_MIN = 4_000;
/** `/attach full` 并入上下文的最大字符数（超出显式截断，绝不静默）。 */
const FULL_EXPAND_CHARS = 300_000;
/** 缓存页图的最大页数（文本层不受此限）。 */
const CACHE_PNG_PAGE_CAP = 100;
/** 缓存页图渲染宽度（视觉补充，不需要高分辨率）。 */
const CACHE_PNG_WIDTH = 1100;
/** OCR 置信度门控：低于此值视为识别失败（回退页面图），避免注入乱码文本。 */
const OCR_MIN_CONFIDENCE = 45;
/** OCR 页图渲染宽度（识别精度需要更高分辨率）。 */
const OCR_PNG_WIDTH = 2000;
/** python 引擎的尝试上限：≤40 页无条件高保真；40-160 页由 python 按内容复杂度（向量密度）自行决定是否让位给 pdfjs。 */
const PYTHON_ATTEMPT_LIMIT = 160;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Read the request body up to `cap` bytes; rejects beyond the cap. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        done = true;
        reject(new Error(`请求体超过上限 ${Math.round(cap / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

function fail(code, message) {
  return { kind: "error", error: { code, message } };
}

function formatCount(count) {
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)} 万`;
  return String(count);
}

/** 从提取文本中识别分节行（工作表/幻灯片标题）作为大纲。 */
function sectionOutline(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*\[(工作表|幻灯片)[^\]]*\]\s*$/.exec(lines[i]);
    if (match !== null) entries.push({ line: i + 1, text: match[0].trim() });
  }
  return entries;
}

/** 组装注入草稿的索引卡（几百 token 量级）。 */
function buildIndexCard({
  input, base, docFile, pageCount, lineCount, charCount,
  outline = [], tree = null, hasPageImages = false, notes = [], aggregateIndex = true
}) {
  const lines = [
    `[附件索引: ${input}]`,
    `- 文档已转存: ${base}/${docFile}（${pageCount > 0 ? `${pageCount} 页 / ` : ""}${formatCount(charCount)} 字符 / ${formatCount(lineCount)} 行）`,
    `- 读取方式: 用 read 工具分页读取（offset/limit，行号即出处坐标）；需要全文时逐段读完即可，不会丢尾部`
  ];
  if (hasPageImages) {
    lines.push(`- 页面图: ${base}/pages/pNN.png，需要看版式/图表时用 read_image 读取（仅视觉模型可用）`);
  }
  if (aggregateIndex) {
    lines.push(`- 缓存清单: ${base}/../INDEX.md（本工作区全部已转存文档）`);
  }
  if (tree !== null) {
    const parts = [];
    for (const child of tree.children ?? []) parts.push(`${child.key}(${child.summary})`);
    lines.push(`- JSON 结构: ${tree.type}${parts.length > 0 ? ` — ${parts.slice(0, 24).join(", ")}${parts.length > 24 ? ", …" : ""}` : ""}`);
  }
  if (outline.length > 0) {
    const items = outline.slice(0, 18).map((entry) => (typeof entry.line === "number" ? `L${entry.line} ${entry.text}` : entry.text));
    lines.push(`- 大纲: ${items.join(" · ")}${outline.length > 18 ? " · …" : ""}`);
  }
  for (const note of notes) lines.push(`- 注意: ${note}`);
  return lines.join("\n");
}

/** 文本结果（任一引擎产出）→ 直插或转存+索引卡（v2b：按上下文余量分流）。 */
async function textResultToResponse(ctx, bytes, input, cwd, textResult, directLimit) {
  const { markdown, pageCount, charCount, lineCount, outline, engine, ocr, notes = [] } = textResult;
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  if (charCount <= limit) {
    const text = notes.length > 0 ? `${markdown}\n\n[附件说明] ${notes.join("；")}` : markdown;
    return { input, kind: "text", text, pageCount, charCount, engine, ocr };
  }
  const tierReason = charCount > DIRECT_TEXT_CHARS ? "size" : "budget";
  // T2：落盘 + 索引卡 + 页面 PNG 视觉补充
  const limits = imageLimitsOf(ctx);
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd);
  const files = [{ name: "doc.md", data: Buffer.from(markdown, "utf8") }];
  let hasPageImages = false;
  if (pageCount > 0 && pageCount <= CACHE_PNG_PAGE_CAP) {
    try {
      const rendered = await renderPdfPages(bytes, {
        pageCap: pageCount,
        maxImageBytes: limits.maxImageBytes,
        maxWidth: CACHE_PNG_WIDTH
      });
      rendered.pages.forEach((page, index) => {
        files.push({
          name: `pages/p${String(index + 1).padStart(2, "0")}.${page.mediaType === "image/jpeg" ? "jpg" : "png"}`,
          data: Buffer.from(page.data)
        });
      });
      hasPageImages = rendered.pages.length > 0;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: page-image rendering failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }
  const { base } = await writeCache({ root, rel }, id, input, "pdf", files, {
    pageCount,
    lineCount,
    charCount,
    hasPageImages,
    outline,
    engine: engine ?? "builtin",
    ocr: ocr ?? false,
    docFile: "doc.md"
  });
  void cleanupCache(root);
  const card = buildIndexCard({
    input,
    base,
    docFile: "doc.md",
    pageCount,
    lineCount,
    charCount,
    outline: (outline ?? []).map((entry) => ({ text: entry })),
    hasPageImages,
    notes: [
      ...(ocr ? ["文本来自 OCR 识别，可能有误差；请用页面图（read_image，需视觉模型）对照核实关键数字。"] : []),
      ...notes
    ]
  });
  return {
    input,
    kind: "index",
    card,
    docPath: `${base}/doc.md`,
    pageCount,
    lineCount,
    charCount,
    engine,
    ocr: ocr ?? false,
    tierReason
  };
}

/** 页面图回退（扫描件且 OCR 不可用/关闭时）。 */
async function imagesFallbackResponse(ctx, bytes, input, warnings) {
  const limits = imageLimitsOf(ctx);
  const pageCap = Math.min(FALLBACK_IMAGE_LIMITS.maxImagesPerMessage, limits.maxImagesPerMessage);
  const rendered = await renderPdfPages(bytes, { pageCap, maxImageBytes: limits.maxImageBytes });
  if (rendered.pages.length === 0) return { input, ...fail("pdf-empty", "PDF 没有任何页面") };
  const stem = baseNameOf(input) || "pdf";
  const all = rendered.total > rendered.rendered
    ? [`PDF 共 ${rendered.total} 页，本次仅附加前 ${rendered.rendered} 页（受单条消息图片上限限制）。`, ...warnings]
    : [...warnings];
  return {
    input,
    kind: "images",
    warnings: all,
    images: rendered.pages.map((page, index) => ({
      name: `${stem}-p${index + 1}.${page.mediaType === "image/jpeg" ? "jpg" : "png"}`,
      mediaType: page.mediaType,
      width: page.width,
      height: page.height,
      data: b64encode(page.data)
    }))
  };
}

/** PDF：文字优先，v3 引擎链 doc-server → python(pymupdf4llm) → builtin(pdfjs) → OCR → 页图。 */
async function convertPdfFile(ctx, bytes, input, cwd, directLimit) {
  const policy = enginePolicy();

  // ---- 引擎 0：外部文档解析服务（DSH_ATTACH_DOC_SERVER）----------------
  if (policy.docServer !== null) {
    try {
      const serverResult = await docServerConvert(bytes, input, policy.docServer);
      const markdown = serverResult.markdown.trim();
      if (markdown !== "") {
        const pageCount = await probePdfPageCount(bytes).catch(() => 0);
        return textResultToResponse(ctx, bytes, input, cwd, {
          markdown,
          pageCount,
          charCount: markdown.length,
          lineCount: markdown.split("\n").length,
          outline: mdOutline(markdown).map((entry) => `L${entry.line} ${entry.title}`),
          engine: "doc-server",
          ocr: false
        }, directLimit);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: doc server failed for ${input}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pythonAvailable = policy.engine !== "builtin" && await probePythonEngine().catch(() => false);

  // ---- 引擎 1/2：文本层提取 --------------------------------------------
  let textResult = null;
  let textError = null;
  if (pythonAvailable) {
    const probedPages = await probePdfPageCount(bytes).catch(() => null);
    if (probedPages !== null && probedPages <= PYTHON_ATTEMPT_LIMIT) {
      const result = await runPythonPdf(bytes).catch((error) => ({ ok: false, error: String(error) }));
      if (result.ok === true && result.hasTextLayer === true && Array.isArray(result.pages)) {
        const sections = result.pages
          .map((page, index) => ({ index, text: String(page ?? "").trim() }))
          .filter((entry) => entry.text !== "")
          .map((entry) => `<!-- p${entry.index + 1} -->\n${entry.text}`);
        const markdown = sections.join("\n\n");
        const charCount = markdown.length;
        // v0.6 P0：书签目录（toc）优先作为大纲；无书签回退 md 标题
        const tocOutline = (Array.isArray(result.toc) ? result.toc : [])
          .filter((entry) => Array.isArray(entry) && typeof entry[1] === "string" && Number.isFinite(entry[2]))
          .map((entry) => `p${entry[2]} ${entry[1].slice(0, 60)}`);
        const mdHeads = mdOutline(markdown).map((entry) => `L${entry.line} ${entry.title}`);
        textResult = {
          markdown,
          pageCount: result.pageCount,
          charCount,
          lineCount: markdown.split("\n").length,
          outline: tocOutline.length >= 2 ? tocOutline : mdHeads,
          engine: result.engine,
          ocr: result.ocr === true
        };
      } else if (result.ok === true && result.skipped === true) {
        // v0.7 内容自适应：大文档低向量密度 → python 主动让位，走 pdfjs 快速引擎
        ctx.logger?.info?.(`dsh-attachment-formats: python engine skipped ${input} (${result.reason ?? "low complexity"}, vectorScore=${result.vectorScore ?? "?"})`);
      } else if (result.ok === false) {
        textError = result.error;
        ctx.logger?.warn?.(`dsh-attachment-formats: python engine failed for ${input}: ${result.error}`);
      }
    } else if (probedPages !== null) {
      textError = `python 引擎仅处理 ≤${PYTHON_ATTEMPT_LIMIT} 页的 PDF，本文件 ${probedPages} 页改用内置引擎`;
    }
  }
  if (textResult === null && policy.engine !== "python") {
    try {
      const extracted = await extractPdfText(bytes);
      if (extracted.hasTextLayer) {
        textResult = {
          markdown: extracted.markdown,
          pageCount: extracted.pageCount,
          charCount: extracted.charCount,
          lineCount: extracted.lineCount,
          outline: extracted.outline,
          engine: "pdfjs",
          ocr: false
        };
      } else if (textError === null) {
        textError = "PDF 没有可用文本层";
      }
    } catch (error) {
      textError = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn?.(`dsh-attachment-formats: builtin text extraction failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }
  if (textResult !== null) return textResultToResponse(ctx, bytes, input, cwd, textResult, directLimit);

  // ---- 引擎 3：扫描件 OCR（v0.7：百度云 API 优先 → tesseract.js 兜底）----
  if (policy.ocr !== "off") {
    try {
      const rendered = await renderPdfPages(bytes, {
        pageCap: OCR_PAGE_CAP,
        maxImageBytes: imageLimitsOf(ctx).maxImageBytes,
        maxWidth: OCR_PNG_WIDTH
      });
      if (rendered.pages.length > 0) {
        let ocr = null;
        let ocrEngine = "tesseract-js";
        let ocrNote = null;
        const useBaidu = policy.baidu.apiKey !== "" && policy.baidu.secretKey !== ""
          && (policy.ocr === "baidu" || policy.ocr === "auto");
        if (useBaidu) {
          try {
            const jpegPages = await Promise.all(rendered.pages.map(async (page) => ({
              data: await sharp(Buffer.from(page.data)).jpeg({ quality: 85 }).toBuffer()
            })));
            const results = await baiduOcrPages(jpegPages, {
              apiKey: policy.baidu.apiKey,
              secretKey: policy.baidu.secretKey,
              accurate: policy.baidu.accurate
            });
            const sections = results
              .map((entry, index) => ({ index, text: entry.text.trim() }))
              .filter((entry) => entry.text !== "")
              .map((entry) => `<!-- p${entry.index + 1} -->\n${entry.text}`);
            const chars = results.reduce((sum, entry) => sum + entry.text.length, 0);
            const confidence = results.length > 0
              ? results.reduce((sum, entry) => sum + entry.confidence, 0) / results.length
              : 0;
            ocr = { text: sections.join("\n\n"), chars, confidence };
            ocrEngine = `baidu${policy.baidu.accurate ? "-accurate" : ""}`;
            ocrNote = `百度 OCR（免费额度 1000 次/月）`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ocrNote = `百度 OCR 不可用（${message}），已回退本地 tesseract.js`;
            ctx.logger?.warn?.(`dsh-attachment-formats: baidu OCR failed for ${input}: ${message}`);
          }
        }
        if (ocr === null && policy.vlm.configured && (policy.ocr === "vlm" || policy.ocr === "auto")) {
          try {
            const jpegPages = await Promise.all(rendered.pages.map(async (page) => ({
              data: await sharp(Buffer.from(page.data)).jpeg({ quality: 85 }).toBuffer()
            })));
            const results = await vlmOcrPages(jpegPages, {
              base: policy.vlm.base,
              key: policy.vlm.key,
              model: policy.vlm.model
            });
            const sections = results
              .map((entry, index) => ({ index, text: entry.text.trim() }))
              .filter((entry) => entry.text !== "")
              .map((entry) => `<!-- p${entry.index + 1} -->\n${entry.text}`);
            const chars = results.reduce((sum, entry) => sum + entry.text.length, 0);
            const confidence = results.length > 0
              ? results.reduce((sum, entry) => sum + entry.confidence, 0) / results.length
              : 0;
            ocr = { text: sections.join("\n\n"), chars, confidence };
            ocrEngine = "vlm";
            ocrNote = `远程 VLM OCR（${policy.vlm.model}，按 token 计费）`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ocrNote = `VLM OCR 不可用（${message}），已回退本地 tesseract.js`;
            ctx.logger?.warn?.(`dsh-attachment-formats: vlm OCR failed for ${input}: ${message}`);
          }
        }
        if (ocr === null && (policy.ocr === "auto" || policy.ocr === "tesseract-js")) {
          const local = await ocrPages(rendered.pages);
          ocr = local;
          ocrEngine = "tesseract-js";
        }
        if (ocr === null && ocrNote !== null) {
          textError = ocrNote; // 强制百度模式且失败：让回退警告说明原因
        }
        if (ocr !== null) {
          if (ocr.chars >= Math.max(10, 10 * rendered.pages.length) && ocr.confidence >= OCR_MIN_CONFIDENCE) {
            return textResultToResponse(ctx, bytes, input, cwd, {
              markdown: ocr.text,
              pageCount: rendered.pages.length,
              charCount: ocr.chars,
              lineCount: ocr.text.split("\n").length,
              outline: [],
              engine: ocrEngine,
              ocr: true,
              notes: [
                ...(rendered.total > rendered.pages.length
                  ? [`OCR 仅处理前 ${rendered.pages.length} 页（文档共 ${rendered.total} 页）`]
                  : []),
                ...(ocrNote !== null ? [ocrNote] : []),
                `OCR 平均置信度 ${Math.round(ocr.confidence)}`
              ]
            }, directLimit);
          }
          if (ocr.chars >= 10 && ocr.confidence < OCR_MIN_CONFIDENCE) {
            textError = `OCR 置信度过低（${Math.round(ocr.confidence)}），识别结果不可靠`;
          }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-attachment-formats: OCR failed for ${input}`);
      ctx.logger?.warn?.(error);
    }
  }

  // ---- 回退：页面图（仅视觉模型路线可用）-------------------------------
  const warnings = [];
  if (textError !== null) warnings.push(`${textError}。`);
  warnings.push("已按页面图片附加——仅视觉模型可以查看；如需文字可用性请安装 OCR（见插件 README）。");
  return imagesFallbackResponse(ctx, bytes, input, warnings);
}

/** Office：提取文本，按上下文余量直插或落盘 + 索引卡。 */
async function convertOfficeFile(ctx, bytes, input, cwd, extract, directLimit) {
  const text = await extract(bytes);
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  if (text.length <= limit) {
    return { input, kind: "text", text, charCount: text.length };
  }
  const tierReason = text.length > DIRECT_TEXT_CHARS ? "size" : "budget";
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd);
  const outline = sectionOutline(text);
  const { base } = await writeCache({ root, rel }, id, input, "office", [
    { name: "doc.md", data: Buffer.from(text, "utf8") }
  ], {
    charCount: text.length,
    lineCount: text.split("\n").length,
    outline,
    engine: "builtin",
    docFile: "doc.md"
  });
  void cleanupCache(root);
  const card = buildIndexCard({
    input,
    base,
    docFile: "doc.md",
    pageCount: 0,
    lineCount: text.split("\n").length,
    charCount: text.length,
    outline: outline.map((entry) => ({ line: entry.line, text: entry.text }))
  });
  return {
    input,
    kind: "index",
    card,
    docPath: `${base}/doc.md`,
    lineCount: text.split("\n").length,
    charCount: text.length,
    tierReason
  };
}

/** 长文本（客户端判定超直插阈值）：解码 + 落盘 + 结构索引。 */
async function convertTextCache(ctx, bytes, input, cwd, directLimit) {
  let text = Buffer.from(bytes).toString("utf8");
  let broken = 0;
  for (const ch of text) if (ch === "\uFFFD") broken += 1;
  if (broken > Math.min(128, Math.max(16, text.length * 0.01))) {
    try {
      const alt = new TextDecoder("gb18030").decode(bytes);
      let altBroken = 0;
      for (const ch of alt) if (ch === "\uFFFD") altBroken += 1;
      if (altBroken < broken) text = alt;
    } catch {
      /* keep utf-8 */
    }
  }
  if (text.trim() === "") return { input, ...fail("empty-file", "文件内容为空") };

  const ext = extensionOf(input);
  let docFile = "doc.md";
  let docData = text;
  let tree = null;
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") {
    try {
      const parsed = JSON.parse(text);
      tree = jsonTree(parsed);
      docFile = "doc.json";
      docData = JSON.stringify(parsed, null, 2);
    } catch {
      try {
        const rows = text.split("\n").filter((line) => line.trim() !== "");
        let parsedRows = 0;
        for (const row of rows) {
          try { JSON.parse(row); parsedRows += 1; } catch { /* not all rows json */ }
        }
        if (parsedRows === rows.length) {
          tree = { type: `jsonl(${rows.length} 行)` };
          docFile = "doc.jsonl";
          docData = text;
        }
      } catch {
        /* keep plain */
      }
    }
  }
  const id = shortHashOf(bytes);
  const { root, rel } = resolveCacheRoot(cwd);
  const outline = ext === "md" || ext === "markdown" ? mdOutline(text) : [];
  const { base } = await writeCache({ root, rel }, id, input, "text", [
    { name: docFile, data: Buffer.from(docData, "utf8") }
  ], {
    charCount: text.length,
    lineCount: text.split("\n").length,
    outline,
    tree,
    engine: "builtin",
    docFile
  });
  void cleanupCache(root);
  const card = buildIndexCard({
    input,
    base,
    docFile,
    pageCount: 0,
    lineCount: text.split("\n").length,
    charCount: text.length,
    outline: outline.map((entry) => ({ line: entry.line, text: entry.title })),
    tree
  });
  return {
    input,
    kind: "index",
    card,
    docPath: `${base}/${docFile}`,
    lineCount: text.split("\n").length,
    charCount: text.length,
    tierReason: text.length > DIRECT_TEXT_CHARS ? "size" : "budget"
  };
}

/** 规范化客户端上报的直插上限（上下文余量感知，v2b）。 */
function normalizeDirectLimit(value) {
  if (!Number.isFinite(value)) return DIRECT_TEXT_CHARS;
  const rounded = Math.floor(value);
  if (rounded < DIRECT_LIMIT_MIN || rounded > DIRECT_TEXT_CHARS) return DIRECT_TEXT_CHARS;
  return rounded;
}

/** Convert one uploaded file into images / text / index (never two kinds). */
async function convertFile(ctx, file, cwd, directLimit) {
  const input = typeof file?.name === "string" && file.name !== "" ? file.name : "attachment";
  if (file === null || typeof file !== "object" || typeof file.data !== "string" || file.data === "") {
    return { input, ...fail("empty-file", "文件内容为空") };
  }
  let bytes;
  try {
    bytes = b64decode(file.data);
  } catch {
    return { input, ...fail("bad-base64", "文件内容编码无效") };
  }
  if (bytes.length === 0) return { input, ...fail("empty-file", "文件内容为空") };
  if (bytes.length > MAX_FILE_BYTES) {
    return {
      input,
      ...fail("file-too-large", `文件超过上限 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`)
    };
  }
  const declared = typeof file.kind === "string" ? file.kind : "";
  const kind = declared === "text-cache" ? "text-cache" : sniffKind(bytes, input);
  const limit = directLimit ?? DIRECT_TEXT_CHARS;
  try {
    switch (kind) {
      case "pdf": return await convertPdfFile(ctx, bytes, input, cwd, limit);
      case "docx": return await convertOfficeFile(ctx, bytes, input, cwd, docxToText, limit);
      case "xlsx": return await convertOfficeFile(ctx, bytes, input, cwd, xlsxToText, limit);
      case "pptx": return await convertOfficeFile(ctx, bytes, input, cwd, pptxToText, limit);
      case "text-cache": return await convertTextCache(ctx, bytes, input, cwd, limit);
      case "tiff": {
        const { pages, total, rendered } = await tiffToPngPages(bytes);
        if (pages.length === 0) return { input, ...fail("tiff-empty", "TIFF 没有任何页面") };
        const stem = baseNameOf(input) || "tiff";
        return {
          input,
          kind: "images",
          warnings: total > rendered
            ? [`TIFF 共 ${total} 页，本次仅附加前 ${rendered} 页（受单条消息图片上限限制）。`]
            : [],
          images: pages.map((page, index) => ({
            name: `${stem}-p${index + 1}.png`,
            mediaType: page.mediaType,
            width: page.width,
            height: page.height,
            data: b64encode(page.data)
          }))
        };
      }
      case "epub":
      case "odt":
      case "rtf": {
        const pandoc = await probePandoc().catch(() => null);
        const extract = (data) => convertPandocFormat(data, kind, pandoc === null ? null : pandoc.path);
        return await convertOfficeFile(ctx, bytes, input, cwd, extract, limit);
      }
      case "doc":
      case "xls":
      case "ppt": {
        const soffice = await probeLibreOffice().catch(() => null);
        if (soffice === null) {
          return {
            input,
            ...fail("missing-libreoffice", `.${kind} 需要 LibreOffice 转换（未检测到 soffice，请安装 https://www.libreoffice.org 后重试）`)
          };
        }
        const converted = await libreOfficeConvert(bytes, kind, soffice.path);
        const extract = kind === "doc" ? docxToText : kind === "xls" ? xlsxToText : pptxToText;
        const result = await convertOfficeFile(ctx, converted.data, input, cwd, extract, limit);
        if (result.kind === "index") {
          result.engine = `libreoffice+${result.engine ?? "builtin"}`;
        }
        return result;
      }
      default: {
        const ext = extensionOf(input);
        return {
          input,
          ...fail("unsupported-format", ext === "" ? "无法识别的文件格式" : `暂不支持 .${ext} 文件`)
        };
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-attachment-formats: conversion failed for ${input}`);
    ctx.logger?.warn?.(error);
    return { input, ...fail("conversion-failed", error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * `/attach` 命令（v2b）：
 *   /attach list              列出已转存文档
 *   /attach full <id|名称>    把全文作为 next-step 消息并入模型上下文
 *                             （下一条消息生效；超限显式截断，绝不静默）
 */
const ATTACH_USAGE = "用法: /attach list 或 /attach full <id|名称>";

function formatDocRow(doc) {
  const size = doc.pageCount > 0
    ? `${doc.pageCount} 页 / ${formatCount(doc.charCount)} 字符`
    : `${formatCount(doc.charCount)} 字符`;
  const flags = [doc.engine, doc.ocr ? "ocr" : null].filter(Boolean).join("/") || "builtin";
  return `- ${doc.id}  ${doc.name}  [${doc.kind}${flags ? ` / ${flags}` : ""}]  ${size}`;
}

export async function executeAttachCommand(ctx, invocation) {
  const cwd = invocation?.agent?.session?.header?.cwd;
  const raw = String(invocation?.rawInput ?? "").trim();
  const parts = raw.split(/\s+/).filter((part) => part !== "");
  const verb = parts[0] ?? "";
  const arg = parts.slice(1).join(" ").trim();

  if (verb === "" || verb === "list") {
    try {
      const docs = await listCachedDocs(cwd);
      if (docs.length === 0) {
        return { kind: "success", text: `当前工作区没有已转存的文档。拖入大文件后即可在此看到。\n${ATTACH_USAGE}` };
      }
      return {
        kind: "success",
        text: `已转存文档（${docs.length} 个）：\n${docs.map(formatDocRow).join("\n")}\n\n${ATTACH_USAGE}`
      };
    } catch (error) {
      return { kind: "error", text: `读取缓存失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (verb === "full") {
    if (arg === "") {
      return { kind: "error", text: `请指定文档：/attach full <id|名称>\n先运行 /attach list 查看可用文档。` };
    }
    try {
      const docs = await listCachedDocs(cwd);
      const query = arg.toLowerCase();
      const doc = docs.find((candidate) => candidate.id === query)
        ?? docs.find((candidate) => candidate.id.startsWith(query))
        ?? docs.find((candidate) => candidate.name.toLowerCase().includes(query))
        ?? null;
      if (doc === null) {
        return {
          kind: "error",
          text: `未找到匹配 "${arg}" 的文档。\n${docs.length > 0 ? `可用文档：${docs.map((d) => `${d.id}(${d.name})`).join("、")}` : "当前没有已转存文档。"}`
        };
      }
      const cached = await readCachedDoc(cwd, doc.id);
      let text = cached.text;
      let truncationNotice = null;
      if (text.length > FULL_EXPAND_CHARS) {
        truncationNotice = `\n\n…[全文过长已截断：原始 ${formatCount(text.length)} 字符，仅并入前 ${formatCount(FULL_EXPAND_CHARS)} 字符；剩余部分可用 read 工具按行读取 ${cached.docFile}]`;
        text = text.slice(0, FULL_EXPAND_CHARS);
      }
      const wrapped = `[附件全文: ${doc.name} (${doc.id})] — 由 /attach full 并入上下文\n\n${text}${truncationNotice ?? ""}`;
      const message = {
        id: crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: wrapped }]
      };
      try {
        invocation.agent.send(message, "next-step", false);
      } catch (error) {
        return { kind: "error", text: `并入上下文失败：${error instanceof Error ? error.message : String(error)}` };
      }
      return {
        kind: "success",
        text: `已将「${doc.name}」全文（${formatCount(text.length)} 字符${truncationNotice !== null ? "，超限部分已截断" : ""}）并入上下文，将在你的下一条消息中生效。\n仍需精读定位时可用 read 工具按行读取 ${cached.docFile}。`
      };
    } catch (error) {
      return { kind: "error", text: `读取文档失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { kind: "error", text: `未知子命令 "${verb}"。\n${ATTACH_USAGE}` };
}

function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
            return;
          }
          const body = await readBody(req, MAX_BODY_BYTES);
          const payload = JSON.parse(body.toString("utf8"));
          const files = Array.isArray(payload?.files) ? payload.files.slice(0, 24) : [];
          if (files.length === 0) {
            sendJson(res, 400, { ok: false, error: { code: "no-files", message: "未提供文件" } });
            return;
          }
          const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : undefined;
          const directLimit = normalizeDirectLimit(payload.directLimitChars);
          const results = [];
          for (const file of files) results.push(await convertFile(ctx, file, cwd, directLimit));
          sendJson(res, 200, { ok: true, results });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: {
              code: "bad-request",
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    }),
    "dsh-attachment-formats: convert route"
  );

  // ---- 缓存管理（P1-3：设置页数据源）----------------------------------
  const queryCwd = (req) => {
    try {
      const value = new URL(req.url ?? "/", "http://x").searchParams.get("cwd");
      return typeof value === "string" && value !== "" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache",
      handler: async (req, res) => {
        const cwd = queryCwd(req);
        const docs = await listCachedDocs(cwd).catch(() => []);
        const { root } = resolveCacheRoot(cwd);
        sendJson(res, 200, {
          ok: true,
          docs,
          sizeBytes: await cacheSize(root).catch(() => 0),
          root
        });
      }
    }),
    "dsh-attachment-formats: cache list route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache/delete",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
          const removed = await removeCachedDocs(body?.cwd, Array.isArray(body?.ids) ? body.ids : []);
          sendJson(res, 200, { ok: true, removed });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) } });
        }
      }
    }),
    "dsh-attachment-formats: cache delete route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/cache/clear",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 POST" } });
          return;
        }
        try {
          const body = JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));
          const cleared = await clearCache(body?.cwd);
          sendJson(res, 200, { ok: true, cleared });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: { code: "bad-request", message: error instanceof Error ? error.message : String(error) } });
        }
      }
    }),
    "dsh-attachment-formats: cache clear route"
  );

  // ---- 工作区零拷贝解析（P2-1）-----------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/attach-formats/resolve",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const cwd = url.searchParams.get("cwd") ?? undefined;
          const name = url.searchParams.get("name") ?? "";
          const size = Number.parseInt(url.searchParams.get("size") ?? "", 10);
          if (name === "" || !Number.isFinite(size) || size < 0) {
            sendJson(res, 200, { ok: true, found: false });
            return;
          }
          const match = await resolveWorkspaceFile(cwd, name, size);
          sendJson(res, 200, { ok: true, found: match !== null, rel: match?.rel ?? null });
        } catch {
          sendJson(res, 200, { ok: true, found: false });
        }
      }
    }),
    "dsh-attachment-formats: workspace resolve route"
  );

  ctx.effect(
    () => ctx.commands.register({
      name: "attach",
      description: "管理附件缓存：list 列出已转存文档，full <id|名称> 把全文并入上下文",
      input: { hint: "[list|full <id|名称>]" },
      handler: (invocation) => executeAttachCommand(ctx, invocation)
    }),
    "dsh-attachment-formats: /attach command"
  );
}

export { name, inject, apply };
export { buildIndexCard, DIRECT_TEXT_CHARS };
