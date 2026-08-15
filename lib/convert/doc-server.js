/**
 * dsh-attachment-formats — 外部文档解析服务（host side，v0.6）。
 *
 * DSH_ATTACH_DOC_SERVER=<base URL> 指向一个文档解析服务（如 PP-StructureV3
 * `paddleocr serve`、MinerU、或任意包装了下列契约的网关）。零依赖（multipart
 * 走 Node 原生 FormData/Blob）。
 *
 * 契约（POST multipart）：
 *   POST {base}/convert
 *     file   : 文件字节（字段名 "file"）
 *     format : "pdf" | "docx" | ...（可选）
 *   → 200 JSON { ok: true, markdown: "..." } | { ok: false, error: "..." }
 */
const TIMEOUT_MS = 300_000;

/**
 * 调用外部解析服务把文档转成 Markdown。
 * @param {Buffer} bytes - 源文件字节。
 * @param {string} name - 文件名（用于 multipart 字段）。
 * @param {string} baseUrl - DSH_ATTACH_DOC_SERVER（去尾斜杠）。
 * @param {typeof fetch} [fetchLike] - 测试注入。
 * @returns {Promise<{ markdown: string }>}
 */
export async function docServerConvert(bytes, name, baseUrl, fetchLike = fetch) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), name);
  form.append("format", "pdf");
  const response = await fetchLike(`${baseUrl.replace(/\/+$/, "")}/convert`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null || typeof payload !== "object") {
    throw new Error(`文档解析服务错误 (HTTP ${response.status}): ${payload?.error ?? payload?.detail ?? "unknown"}`);
  }
  if (payload.ok !== true || typeof payload.markdown !== "string") {
    throw new Error(payload.error ?? "文档解析服务返回格式异常");
  }
  return { markdown: payload.markdown };
}
