/**
 * dsh-attachment-formats — 附件缓存落盘（host side，v2a）。
 *
 * 长文档转换产物写入工作区 `.dsh-attachments/<sha-8>/`（内容寻址，
 * 同文件重复拖入复用），带 manifest.json；模型用 DSH 现成 read/read_image
 * 工具按需分页读取。目录同时做 7 天过期清理（尽力而为）。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";

export const CACHE_DIR_NAME = ".dsh-attachments";
const CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 短哈希（内容寻址目录名）。 */
export function shortHashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * 解析缓存根目录：优先会话工作区；无有效 cwd 时回退 DSH_HOME/storages。
 * @param {string|undefined} cwd - 客户端上报的会话工作区（须绝对路径）。
 * @returns {{ root: string, rel: string|null }} root 为绝对路径；rel 为
 *   "相对 cwd 的展示路径"（模型 read 工具可解析），回退时为 null。
 */
export function resolveCacheRoot(cwd) {
  if (typeof cwd === "string" && cwd !== "" && isAbsolute(cwd)) {
    return { root: join(cwd, CACHE_DIR_NAME), rel: CACHE_DIR_NAME };
  }
  const dshHome = process.env.DSH_HOME ?? "";
  if (dshHome !== "") {
    return { root: join(dshHome, "storages", "attachment-docs"), rel: null };
  }
  return { root: join(process.cwd(), CACHE_DIR_NAME), rel: null };
}

/** 落盘一组文件并写 manifest；返回展示路径（相对 cwd）或绝对回退路径。 */
export async function writeCache({ root, rel }, id, sourceName, kind, files, extra = {}) {
  const dir = join(root, id);
  await mkdir(join(dir, "pages"), { recursive: true });
  const written = [];
  for (const file of files) {
    const target = join(dir, file.name.replace(/^\.\./, ""));
    await writeFile(target, file.data);
    written.push(file.name);
  }
  const manifest = {
    kind,
    sourceName,
    id,
    createdAt: new Date().toISOString(),
    files: written,
    ...extra
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const base = rel === null ? dir : `${rel}/${id}`;
  await touchAggregateIndex(root, { id, sourceName, kind, docFile: extra.docFile ?? written.find((name) => name.endsWith(".md") || name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".txt")) ?? written[0] ?? "doc.md", pageCount: extra.pageCount ?? 0, lineCount: extra.lineCount ?? 0, charCount: extra.charCount ?? 0, engine: extra.engine ?? null, ocr: extra.ocr ?? false });
  return { dir, base };
}

/**
 * 维护工作区缓存根下的聚合清单 INDEX.md（多文档聚合索引，v3）：
 * 每次落盘 upsert 一行，模型读一个文件即可看到全部已转存文档。
 */
export async function touchAggregateIndex(root, entry) {
  try {
    await mkdir(root, { recursive: true });
    const indexPath = join(root, "INDEX.md");
    let content = "# 附件缓存清单（.dsh-attachments）\n";
    content += "\n已转存的文档如下；每个条目目录内有 doc.* 与 manifest.json，页面图在 pages/。\n\n";
    const rows = [];
    try {
      const existing = await readFile(indexPath, "utf8");
      for (const line of existing.split("\n")) {
        if (line.startsWith("| ") && line.includes("|") && !line.startsWith("| id")) {
          rows.push(line);
        }
      }
    } catch {
      /* 首次创建 */
    }
    const flags = [entry.engine, entry.ocr ? "ocr" : null].filter(Boolean).join("/") || "builtin";
    const sizeText = entry.pageCount > 0
      ? `${entry.pageCount} 页 / ${entry.charCount} 字符`
      : `${entry.lineCount} 行 / ${entry.charCount} 字符`;
    const row = `| ${entry.id} | ${entry.sourceName} | ${entry.kind} | ${entry.docFile} | ${sizeText} | ${flags} | ${entry.createdAt ?? ""} |`;
    const filtered = rows.filter((line) => !line.startsWith(`| ${entry.id} |`));
    filtered.push(row);
    content += "| id | 来源 | 类型 | 主文件 | 规模 | 引擎 | 转存时间 |\n";
    content += "| --- | --- | --- | --- | --- | --- | --- |\n";
    content += filtered.join("\n") + "\n";
    await writeFile(indexPath, content);
  } catch {
    /* 聚合索引失败不影响主流程 */
  }
}

/** 尽力而为的过期清理：删除 root 下 7 天未更新的子目录。 */
export async function cleanupCache(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        const info = await stat(dir);
        if (now - info.mtimeMs > CLEANUP_TTL_MS) await rm(dir, { recursive: true, force: true });
      } catch {
        /* 单个目录清理失败不影响其它 */
      }
    }
  } catch {
    /* 根目录不存在或不可读：跳过 */
  }
}

/** 列出工作区缓存中的全部文档（按转存时间倒序）。 */
export async function listCachedDocs(cwd) {
  const { root } = resolveCacheRoot(cwd);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const docs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{8}$/i.test(entry.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(join(root, entry.name, "manifest.json"), "utf8"));
      docs.push({
        id: entry.name,
        name: typeof manifest.sourceName === "string" ? manifest.sourceName : entry.name,
        kind: typeof manifest.kind === "string" ? manifest.kind : "unknown",
        docFile: typeof manifest.docFile === "string" ? manifest.docFile : void 0,
        pageCount: Number.isFinite(manifest.pageCount) ? manifest.pageCount : 0,
        lineCount: Number.isFinite(manifest.lineCount) ? manifest.lineCount : 0,
        charCount: Number.isFinite(manifest.charCount) ? manifest.charCount : 0,
        engine: typeof manifest.engine === "string" ? manifest.engine : null,
        ocr: manifest.ocr === true,
        createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null
      });
    } catch {
      /* 坏 manifest 跳过 */
    }
  }
  docs.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return docs;
}

/** 读取一份缓存文档的全文（id 白名单校验防路径穿越）。 */
export async function readCachedDoc(cwd, id) {
  if (!/^[a-f0-9]{8}$/i.test(String(id ?? ""))) {
    throw new Error(`无效的文档 id: ${id}`);
  }
  const { root } = resolveCacheRoot(cwd);
  const dir = join(root, id);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  let docFile = typeof manifest.docFile === "string" ? manifest.docFile : void 0;
  if (docFile === undefined || docFile.includes("..") || docFile.includes("/") || docFile.includes("\\")) {
    const files = await readdir(dir);
    docFile = files.find((name) => /\.(md|json|jsonl|txt)$/i.test(name)) ?? "doc.md";
  }
  const text = await readFile(join(dir, docFile), "utf8");
  return { manifest, docFile, text };
}
