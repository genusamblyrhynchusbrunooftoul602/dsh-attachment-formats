/**
 * dsh-attachment-formats — shared host-side conversion utilities.
 *
 * Magic-byte sniffing (host never trusts the client-declared kind), base64
 * helpers, and the deployment-independent fallback limits used when the
 * attachments service is unavailable.
 */

/** Fallback attachment policy; mirrors @deepseek-ai/dsh-attachment-local defaults. */
export const FALLBACK_IMAGE_LIMITS = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40 * 1000 * 1000,
  mediaTypes: Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"])
});

/** Largest accepted encoded file for a single conversion request (raw bytes). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Hard cap on pages rendered from one PDF; the effective cap is min(this, imageLimits.maxImagesPerMessage). */
export const PDF_PAGE_CAP = 24;
/** Maximum characters extracted into the composer from one office/text document. */
export const MAX_TEXT_CHARS = 300_000;

/**
 * Classify encoded bytes by magic numbers.
 * @param {Uint8Array} bytes - file head (first 64 bytes suffice).
 * @param {string} name - display name used for the extension fallback.
 * @returns {"pdf"|"docx"|"xlsx"|"pptx"|"unknown"} - host conversion kind.
 */
export function sniffKind(bytes, name = "") {
  const head = bytes.subarray(0, 16);
  const ascii = (from, length) => {
    let out = "";
    for (let i = from; i < Math.min(from + length, head.length); i += 1) {
      const c = head[i];
      out += String.fromCharCode(c >= 32 && c < 127 ? c : 46);
    }
    return out;
  };
  const ext = extensionOf(name);
  if (ascii(0, 5) === "%PDF-") return "pdf";
  // TIFF：II*\0 或 MM\0*
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a)) {
    return "tiff";
  }
  // OLE 复合文档（旧版 doc/xls/ppt）
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0
    && head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1) {
    if (ext === "doc" || ext === "xls" || ext === "ppt") return ext;
    return "unknown";
  }
  // RTF：{\rtf
  if (ascii(0, 5) === "{\\rtf") return "rtf";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // ZIP 容器 — 用扩展名判别（OOXML / epub / odt）
    if (ext === "docx" || ext === "xlsx" || ext === "pptx" || ext === "epub" || ext === "odt") return ext;
    return "unknown";
  }
  return "unknown";
}

/** Lowercase extension of a file name, without the dot. */
export function extensionOf(name) {
  const base = String(name ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1);
}

/** Strip the path and extension directory cruft from a display name. */
export function baseNameOf(name) {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "attachment";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Decode a standard base64 payload (with or without padding) to a Buffer. */
export function b64decode(data) {
  const text = String(data ?? "").replace(/\s+/g, "");
  return Buffer.from(text, "base64");
}

/** Encode a Buffer to standard base64. */
export function b64encode(data) {
  return Buffer.from(data).toString("base64");
}

/** Read the deployment attachment policy when available, else fall back. */
export function imageLimitsOf(ctx) {
  try {
    const attachments = ctx.get("attachments");
    if (attachments !== void 0 && attachments !== null && typeof attachments.imageLimits === "object") {
      const limits = attachments.imageLimits;
      if (limits !== null && typeof limits.maxImagesPerMessage === "number") return limits;
    }
  } catch {
    /* the attachments service is optional at plugin time */
  }
  return FALLBACK_IMAGE_LIMITS;
}

/** Truncate extracted text to the policy cap with an explicit notice. */
export function capText(text, cap = MAX_TEXT_CHARS) {
  if (text.length <= cap) return text;
  const notice = `\n…[内容过长，已截断：原始 ${text.length} 字符，仅保留前 ${cap} 字符]`;
  return text.slice(0, cap) + notice;
}
