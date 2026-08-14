/**
 * dsh-attachment-formats — XLSX → text (host side).
 *
 * Each worksheet becomes a section of tab-separated rows (formula cells use
 * their cached result, formatted values use the display text). Sheets are
 * emitted in workbook order with an explicit `[工作表: name]` header.
 */
import ExcelJS from "exceljs";
import { capText, MAX_TEXT_CHARS } from "./util.js";

/** Render one cell to the flat text form used in the TSV grid. */
function cellText(cell) {
  try {
    if (cell.type === ExcelJS.ValueType.Formula) {
      const result = cell.result;
      if (result !== null && result !== undefined && !(result instanceof Error)) return String(result);
      return cell.text ?? "";
    }
    if (cell.type === ExcelJS.ValueType.RichText) {
      const parts = Array.isArray(cell.value?.richText)
        ? cell.value.richText.map((part) => part.text ?? "").join("")
        : cell.text ?? "";
      return parts;
    }
    const text = cell.text;
    if (typeof text === "string" && text !== "") return text;
    const value = cell.value;
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? String(value.text ?? value.result ?? "") : String(value);
  } catch {
    return "";
  }
}

/**
 * Extract text from an encoded .xlsx.
 * @param {Uint8Array} data - encoded XLSX (zip) bytes.
 * @returns {Promise<string>} tab-separated sections, truncated by policy.
 */
export async function xlsxToText(data) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(data));
  const sections = [];
  for (const sheet of workbook.worksheets) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        cells.push(cellText(cell));
      });
      const line = cells.join("\t");
      if (line.trim() !== "") rows.push(line);
    });
    sections.push(`[工作表: ${sheet.name}]\n${rows.join("\n")}`);
  }
  return capText(sections.join("\n\n"), MAX_TEXT_CHARS);
}
