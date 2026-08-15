/**
 * dsh-attachment-formats — DOCX → Markdown（host side，v0.6 P0 升级）。
 *
 * mammoth 的 HTML 输出（保留表格/标题结构）→ turndown + GFM 插件 →
 * Markdown（表格保留为 pipe 表）。图片丢弃（v0.6 范围内）；HTML 转空时
 * 回退 extractRawText。
 */
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { capText, MAX_TEXT_CHARS } from "./util.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);
turndown.remove(["script", "style", "img", "svg"]);

/**
 * Extract Markdown from an encoded .docx (tables preserved as pipe tables).
 * @param {Uint8Array} data - encoded DOCX (zip) bytes.
 * @returns {Promise<string>} markdown text, truncated by policy.
 */
export async function docxToText(data) {
  const buffer = Buffer.from(data);
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) }
  );
  const markdown = turndown.turndown(html).replace(/\u0000/g, "");
  const trimmed = markdown.trim();
  if (trimmed !== "") return capText(trimmed, MAX_TEXT_CHARS);
  // 兜底：结构极简的 docx 退回纯文本
  const { value: raw } = await mammoth.extractRawText({ buffer });
  return capText(raw.replace(/\u0000/g, ""), MAX_TEXT_CHARS);
}
