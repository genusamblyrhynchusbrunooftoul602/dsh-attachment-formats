/**
 * dsh-attachment-formats — 附件缓存落盘（host side，v2a）。
 *
 * 长文档转换产物写入工作区 `.dsh-attachments/<sha-16>/`（内容寻址，
 * 同文件重复拖入复用），带 manifest.json；模型用 DSH 现成 read/read_image
 * 工具按需分页读取。目录同时做约 7 天未访问过期清理（尽力而为，
 * 以 manifest.lastAccessedAt 与主文档文件系统访问时间为准）。
 */
import { join, isAbsolute, relative, sep } from "node:path";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const CACHE_DIR_NAME = ".dsh-attachments";
const CLEANUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存 schema 版本：转换逻辑/产物结构变化时递增，旧缓存自动失效。 */
export const CACHE_SCHEMA_VERSION = 2;
/** 缓存目录 id 的十六进制长度（64 bit 碰撞空间；manifest 内另存完整哈希）。 */
const DIR_ID_HEX = 16;
const DIR_ID_RE = new RegExp(`^[a-f0-9]{${DIR_ID_HEX}}$`, "i");
/** v0.6.1 及更早版本的 8-hex 遗留目录：active 查找不认，仅由清理路径删除。 */
const LEGACY_ID_RE = /^[a-f0-9]{8}$/i;

/** 原子写 JSON（临时文件 + rename）：并发 reader 只会看到旧/新完整文件，不会读到半截。 */
async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

/** 原子写文本（临时文件 + rename）。 */
async function writeTextAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

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
  await writeJsonAtomic(join(dir, "manifest.json"), manifest);
  const base = rel === null ? dir : `${rel}/${id}`;
  await rebuildIndex(root);
  return { dir, base };
}

/** 更新 manifest.lastAccessedAt（读取/命中时调用；写 manifest 同时刷新目录 mtime）。 */
export async function touchCachedDoc(root, id) {
  try {
    const path = join(root, id, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.lastAccessedAt = new Date().toISOString();
    await writeJsonAtomic(path, manifest);
  } catch {
    /* 读取路径失败不阻断主流程 */
  }
}

/** 增量补写 manifest 字段（例如缓存命中时惰性生成页面图后置 hasPageImages）。 */
export async function patchCachedManifest(root, id, patch) {
  try {
    const path = join(root, id, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    Object.assign(manifest, patch);
    await writeJsonAtomic(path, manifest);
    return manifest;
  } catch {
    return null;
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

/** Markdown 表格单元格转义：反斜杠/管道符转义，换行折叠为空格。 */
function mdCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ");
}

/** 单次 INDEX 重建（内部实现）。 */
async function doRebuildIndex(root) {
  try {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    const docs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !DIR_ID_RE.test(entry.name)) continue;
      try {
        const manifest = JSON.parse(await readFile(join(root, entry.name, "manifest.json"), "utf8"));
        if (manifest.schemaVersion !== CACHE_SCHEMA_VERSION) continue;
        docs.push({
          id: entry.name,
          sourceName: typeof manifest.sourceName === "string" ? manifest.sourceName : entry.name,
          kind: typeof manifest.kind === "string" ? manifest.kind : "unknown",
          docFile: typeof manifest.docFile === "string" ? manifest.docFile : "",
          pageCount: Number.isFinite(manifest.pageCount) ? manifest.pageCount : 0,
          lineCount: Number.isFinite(manifest.lineCount) ? manifest.lineCount : 0,
          charCount: Number.isFinite(manifest.charCount) ? manifest.charCount : 0,
          engine: typeof manifest.engine === "string" ? manifest.engine : null,
          ocr: manifest.ocr === true,
          createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : ""
        });
      } catch {
        /* 坏 manifest 跳过 */
      }
    }
    docs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let content = "# 附件缓存清单（.dsh-attachments）\n";
    content += "\n已转存的文档如下；每个条目目录内有 doc.* 与 manifest.json，页面图在 pages/。\n\n";
    content += "| id | 来源 | 类型 | 主文件 | 规模 | 引擎 | 转存时间 |\n";
    content += "| --- | --- | --- | --- | --- | --- | --- |\n";
    for (const doc of docs) {
      const flags = [doc.engine, doc.ocr ? "ocr" : null].filter(Boolean).join("/") || "builtin";
      const sizeText = doc.pageCount > 0
        ? `${doc.pageCount} 页 / ${doc.charCount} 字符`
        : `${doc.lineCount} 行 / ${doc.charCount} 字符`;
      const created = doc.createdAt === "" ? "" : new Date(doc.createdAt).toISOString().replace("T", " ").slice(0, 19);
      content += `| ${mdCell(doc.id)} | ${mdCell(doc.sourceName)} | ${mdCell(doc.kind)} | ${mdCell(doc.docFile)} | ${sizeText} | ${mdCell(flags)} | ${created} |\n`;
    }
    await writeTextAtomic(join(root, "INDEX.md"), content);
  } catch {
    /* 聚合索引失败不影响主流程 */
  }
}

/**
 * 从当前合法 manifest 全量重建工作区缓存根下的聚合清单 INDEX.md（v3）：
 * 不再做增量 upsert——write/delete/cleanup 后重生成，杜绝 ghost 行与
 * 旧 sha-8 遗留记录。按 root 串行化（per-root async queue）：并发写入的
 * 多个请求不会互相覆盖，最后一次重建总是看到最新的完整状态。
 * 模型读一个文件即可看到全部已转存文档。
 */
const rebuildQueues = new Map();
export function rebuildIndex(root) {
  const previous = rebuildQueues.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => doRebuildIndex(root));
  rebuildQueues.set(root, next);
  next.finally(() => {
    if (rebuildQueues.get(root) === next) rebuildQueues.delete(root);
  }).catch(() => {});
  return next;
}

/**
 * 尽力而为的过期清理：删除 root 下「约 7 天未访问」的子目录。
 * 访问信号 = max(目录 mtime, manifest.lastAccessedAt（插件侧读取/命中续期）,
 * 主文档文件 atime/mtime（模型直接用 read 工具读取 doc.* 的文件系统信号；
 * noatime/relatime 挂载下 atime 可能不更新，故只能尽力而为）)。
 */
export async function cleanupCache(root, now = Date.now()) {
  let deleted = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // v0.6.1 及更早的 8-hex 遗留目录：active 查找不认（schema 已失效），
      // 在清理路径直接删除，避免成为永不可见的孤儿。
      if (LEGACY_ID_RE.test(entry.name)) {
        try {
          await rm(join(root, entry.name), { recursive: true, force: true });
          deleted += 1;
        } catch {
          /* 单个目录清理失败不影响其它 */
        }
        continue;
      }
      if (!DIR_ID_RE.test(entry.name)) continue;
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
        if (now - lastAccessMs > CLEANUP_TTL_MS) {
          await rm(dir, { recursive: true, force: true });
          deleted += 1;
        }
      } catch {
        /* 单个目录清理失败不影响其它 */
      }
    }
  } catch {
    /* 根目录不存在或不可读：跳过 */
  }
  if (deleted > 0) await rebuildIndex(root);
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

/** 删除指定文档目录（id 白名单）；删除后全量重建 INDEX，杜绝 ghost 行。 */
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
  if (removed.length > 0) await rebuildIndex(root);
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
      // 当前 16-hex 目录与 v0.6.1 遗留的 8-hex 目录一并清除
      if (entry.isDirectory() && (DIR_ID_RE.test(entry.name) || LEGACY_ID_RE.test(entry.name))) {
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
 * 工作区零拷贝解析：在 cwd 内按「文件名 + 字节数」找候选，再用完整
 * SHA-256 与客户端计算的源文件哈希严格相等才判定同源（杜绝同名同大小
 * 不同内容导致的 silent attachment substitution）。
 * @param {string} cwd - 会话工作区绝对路径。
 * @param {string} name - 拖入文件的名字。
 * @param {number} size - 拖入文件的字节数。
 * @param {{ timeoutMs?: number, maxDepth?: number, hash?: string|null }} [options]
 *   hash 为 64-hex 完整 SHA-256；缺省/非法时直接不做同源判定（返回 null）。
 * @returns {Promise<{ abs: string, rel: string } | null>} rel 为 POSIX 相对路径。
 */
export async function resolveWorkspaceFile(cwd, name, size, options = {}) {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof name !== "string" || name === "") return null;
  const timeoutMs = options.timeoutMs ?? 2500;
  const maxDepth = options.maxDepth ?? 8;
  const hash = typeof options.hash === "string" && /^[a-f0-9]{64}$/i.test(options.hash)
    ? options.hash.toLowerCase()
    : null;
  if (hash === null) return null; // 无完整哈希不做同源判定：name+size 只配当候选过滤器
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
        if (info.size !== size) continue;
        // 完整哈希确认：内容必须逐字节同源，否则跳过候选继续找
        const data = await readFile(join(dir, entry.name));
        if (sha256Of(data) !== hash) continue;
        return {
          abs: join(dir, entry.name),
          rel: relative(cwd, join(dir, entry.name)).split(sep).join("/")
        };
      } catch {
        /* 下一候选 */
      }
    }
  }
  return null;
}
