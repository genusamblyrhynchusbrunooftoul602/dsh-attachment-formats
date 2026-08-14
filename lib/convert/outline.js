/**
 * dsh-attachment-formats — 长文本索引结构（host side，v2a）。
 *
 * 为落盘缓存的长文档生成索引卡片所需的轻量结构：
 *   - Markdown/文本：前两级标题大纲（含行号）；
 *   - JSON：第一层键树（键名 + 类型 + 元素数/字段数）。
 */

/** 从文本中提取 markdown 标题大纲（#/##/###，最多 60 条）。 */
export function mdOutline(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,3})\s+(.*)$/.exec(lines[i]);
    if (match === null) continue;
    const level = match[1].length;
    const title = match[2].trim().replace(/[#*_`[\]]/g, "").trim();
    if (title === "") continue;
    entries.push({ line: i + 1, level, title: title.length > 60 ? `${title.slice(0, 60)}…` : title });
    if (entries.length >= 60) break;
  }
  return entries;
}

/** 从解析后的 JSON 构建第一层键树（递归深度 1，仅统计）。 */
export function jsonTree(value, depth = 0) {
  if (depth > 1 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    return { type: `array(${value.length})`, children: null };
  }
  const keys = Object.keys(value);
  const children = keys.slice(0, 50).map((key) => {
    const child = value[key];
    let summary;
    if (Array.isArray(child)) summary = `array(${child.length})`;
    else if (child !== null && typeof child === "object") summary = `object(${Object.keys(child).length} keys)`;
    else if (typeof child === "string") summary = `string(${child.length})`;
    else summary = typeof child;
    return { key, summary };
  });
  return {
    type: `object(${keys.length} keys${keys.length > 50 ? ", 仅列前 50" : ""})`,
    children
  };
}
