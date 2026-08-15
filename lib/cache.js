/**
 * dsh-attachment-formats — 附件缓存落盘（host side，v2a）。
 *
 * 长文档转换产物写入工作区 `.dsh-attachments/<sha-16>/`（内容寻址，
 * 同文件重复拖入复用），带 manifest.json；模型用 DSH 现成 read/read_image
 * 工具按需分页读取。目录同时做约 7 天未访问过期清理（尽力而为，
 * 以 manifest.lastAccessedAt 与主文档文件系统访问时间为准）。
 */
import { join, isAbsolute, relative, sep } from "node:path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const CACHE_DIR_NAME = ".dsh-attachments";
const CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存 schema 版本：转换逻辑/产物结构变化时递增，旧缓存自动失效。 */
export const CACHE_SCHEMA_VERSION = 2;
/** 缓存目录 id 的十六进制长度（64 bit 碰撞空间；manifest 内另存完整哈希）。 */
const DIR_ID_HEX = 16;
const DIR_ID_RE = new RegExp(`^[a-f0-9]{${DIR_ID_HEX}}$`, "i");

/** 完整 SHA-256（manifest.sourceHash 用，与目录短 id 双重校验）。 */
export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 短哈希（内容寻址目录名，16 hex）。 */
export function shortHashOf(bytes) {
  return sha256Of(bytes).slice(0, DIR_ID_HEX);
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
  const now = new Date().toISOString();
  const manifest = {
    kind,
    sourceName,
    id,
    createdAt: now,
    lastAccessedAt: now,
    schemaVersion: CACHE_SCHEMA_VERSION,
    files: written,
    ...extra
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const base = rel === null ? dir : `${rel}/${id}`;
  await touchAggregateIndex(root, { id, sourceName, kind, docFile: extra.docFile ?? written.find((name) => name.endsWith(".md") || name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".txt")) ?? written[0] ?? "doc.md", pageCount: extra.pageCount ?? 0, lineCount: extra.lineCount ?? 0, charCount: extra.charCount ?? 0, engine: extra.engine ?? null, ocr: extra.ocr ?? false });
  return { dir, base };
}

/** 更新 manifest.lastAccessedAt（读取/命中时调用；写 manifest 同时刷新目录 mtime）。 */
export async function touchCachedDoc(root, id) {
  try {
    const path = join(root, id, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.lastAccessedAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  } catch {
    /* 读取路径失败不阻断主流程 */
  }
}

/**
 * 命中检查：manifest 存在、schema 版本一致、sourceHash（完整 SHA-256）
 * 与源文件严格一致，且主文本文件在盘上。converterFingerprint 由调用方
 * （cachedTextResponse）按当前转换策略比对。
 * 命中返回 { manifest, text, docFile }，否则 null。
 */
export async function readCachedTextIfValid(root, id, sourceHash) {
  if (!DIR_ID_RE.test(String(id ?? ""))) return null;
  const dir = join(root, id);
  try {
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    // 完整哈希严格相等：短目录 id 碰撞时仍能区分（双保险）
    if (typeof manifest.sourceHash !== "string" || manifest.sourceHash !== sourceHash) return null;
    let docFile = typeof manifest.docFile === "string" ? manifest.docFile : void 0;
    if (docFile === undefined || docFile.includes("..") || docFile.includes("/") || docFile.includes("\\")) {
      const files = await readdir(dir);
      docFile = files.find((name) => /\.(md|json|jsonl|txt)$/i.test(name)) ?? "doc.md";
    }
    const text = await readFile(join(dir, docFile), "utf8");
    return { manifest, text, docFile };
  } catch {
    return null;
  }
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

/**
 * 尽力而为的过期清理：删除 root 下「约 7 天未访问」的子目录。
 * 访问信号 = max(目录 mtime, manifest.lastAccessedAt（插件侧读取/命中续期）,
 * 主文档文件 atime/mtime（模型直接用 read 工具读取 doc.* 的文件系统信号；
 * noatime/relatime 挂载下 atime 可能不更新，故只能尽力而为）)。
 */
export async function cleanupCache(root, now = Date.now()) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !DIR_ID_RE.test(entry.name)) continue;
      const dir = join(root, entry.name);
      try {
        const info = await stat(dir);
        let lastAccessMs = info.mtimeMs;
        try {
          const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
          const accessed = new Date(manifest.lastAccessedAt ?? "").getTime();
          if (Number.isFinite(accessed)) lastAccessMs = Math.max(lastAccessMs, accessed);
          const docFile = typeof manifest.docFile === "string"
            && manifest.docFile !== ""
            && !manifest.docFile.includes("..")
            && !manifest.docFile.includes("/")
            && !manifest.docFile.includes("\\")
            ? manifest.docFile
            : null;
          if (docFile !== null) {
            const docStat = await stat(join(dir, docFile));
            lastAccessMs = Math.max(lastAccessMs, docStat.atimeMs, docStat.mtimeMs);
          }
        } catch {
          /* 无 manifest 时按目录 mtime */
        }
        if (now - lastAccessMs > CLEANUP_TTL_MS) await rm(dir, { recursive: true, force: true });
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
    if (!entry.isDirectory() || !DIR_ID_RE.test(entry.name)) continue;
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

/** 读取一份缓存文档的全文（id 白名单校验防路径穿越；读取刷新 lastAccessedAt）。 */
export async function readCachedDoc(cwd, id) {
  if (!DIR_ID_RE.test(String(id ?? ""))) {
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
  void touchCachedDoc(root, id); // 访问即续期（TTL 语义：约 7 天未访问；模型直接 read 以文件 atime 辅助判断）
  return { manifest, docFile, text };
}

/** 递归计算缓存根的总字节数（尽力而为）。 */
export async function cacheSize(root) {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        try {
          total += (await stat(path)).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  await walk(root);
  return total;
}

/** 删除指定文档目录（id 白名单）。 */
export async function removeCachedDocs(cwd, ids) {
  const { root } = resolveCacheRoot(cwd);
  const removed = [];
  for (const id of ids) {
    if (!DIR_ID_RE.test(String(id ?? ""))) continue;
    try {
      await rm(join(root, id), { recursive: true, force: true });
      removed.push(id);
    } catch {
      /* 单个失败不阻断 */
    }
  }
  return removed;
}

/** 清空全部文档目录与聚合索引。 */
export async function clearCache(cwd) {
  const { root } = resolveCacheRoot(cwd);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const entry of entries) {
    try {
      if (entry.isDirectory() && DIR_ID_RE.test(entry.name)) {
        await rm(join(root, entry.name), { recursive: true, force: true });
        cleared += 1;
      } else if (entry.isFile() && entry.name === "INDEX.md") {
        await rm(join(root, entry.name), { force: true });
      }
    } catch {
      /* 单个失败不阻断 */
    }
  }
  return cleared;
}

/** 搜索工作区时跳过的目录（加速 + 避免误匹配依赖树）。 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".venv", "vendor", "dist", "build", "temp",
  ".dsh-attachments", "__pycache__", ".next", ".nuxt"
]);

/**
 * 工作区零拷贝解析：在 cwd 内按「文件名 + 字节数」找同源文件。
 * @param {string} cwd - 会话工作区绝对路径。
 * @param {string} name - 拖入文件的名字。
 * @param {number} size - 拖入文件的字节数。
 * @param {{ timeoutMs?: number, maxDepth?: number }} [options]
 * @returns {Promise<{ abs: string, rel: string } | null>} rel 为 POSIX 相对路径。
 */
export async function resolveWorkspaceFile(cwd, name, size, options = {}) {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof name !== "string" || name === "") return null;
  const timeoutMs = options.timeoutMs ?? 2500;
  const maxDepth = options.maxDepth ?? 8;
  const deadline = Date.now() + timeoutMs;
  const queue = [{ dir: cwd, depth: 0 }];
  while (queue.length > 0) {
    if (Date.now() > deadline) return null; // 超时放弃，回退字节上传
    const { dir, depth } = queue.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.name !== name) continue;
      try {
        const info = await stat(join(dir, entry.name));
        if (info.size === size) {
          return {
            abs: join(dir, entry.name),
            rel: relative(cwd, join(dir, entry.name)).split(sep).join("/")
          };
        }
      } catch {
        /* 下一候选 */
      }
    }
  }
  return null;
}
