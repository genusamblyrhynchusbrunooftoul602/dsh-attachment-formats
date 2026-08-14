/**
 * dsh-attachment-formats — DOCX → plain text (host side).
 *
 * mammoth's raw-text extractor walks the document body in reading order;
 * paragraph breaks are preserved, images/formulas are dropped. Tables keep
 * their cell text but lose grid layout — see the project README.
 */
import mammoth from "mammoth";
import { capText, MAX_TEXT_CHARS } from "./util.js";

/**
 * Extract plain text from an encoded .docx.
 * @param {Uint8Array} data - encoded DOCX (zip) bytes.
 * @returns {Promise<string>} extracted text, truncated by policy.
 */
export async function docxToText(data) {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
  return capText(value.replace(/\u0000/g, ""), MAX_TEXT_CHARS);
}
