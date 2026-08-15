/**
 * dsh-attachment-formats — 远程 VLM OCR（host side，v0.6）。
 *
 * 经 OpenAI 兼容 chat/completions 端点用视觉语言模型（如 olmOCR-2、GLM-4V、
 * Qwen-VL）逐页转录扫描件。按 token 计费，作为百度 OCR 之外的可选云后端。
 *
 * 配置（env）：
 *   DSH_ATTACH_VLM_BASE   OpenAI 兼容 base URL（如 pi-ai 网关 / OpenAI）
 *   DSH_ATTACH_VLM_KEY    密钥（可选，无则不带 Authorization）
 *   DSH_ATTACH_VLM_MODEL  模型名（必填）
 *   DSH_ATTACH_OCR=vlm    强制走 VLM（auto 顺序：百度 → VLM → tesseract.js）
 */
const TRANSCRIBE_PROMPT = "逐字转录这张扫描页面上的全部文字，按阅读顺序输出，保留段落与换行。只输出页面文字本身，不要任何解释或格式标记。";

/**
 * 用 VLM 识别一页 JPEG。
 * @param {Buffer} jpeg - 页面 JPEG。
 * @param {{ base: string, key: string, model: string }} options
 * @param {typeof fetch} [fetchLike]
 */
export async function vlmOcrPage(jpeg, options, fetchLike = fetch) {
  const headers = { "content-type": "application/json" };
  if (options.key !== "") headers.Authorization = `Bearer ${options.key}`;
  const response = await fetchLike(`${options.base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: options.model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: TRANSCRIBE_PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } }
        ]
      }],
      max_tokens: 4096
    }),
    signal: AbortSignal.timeout(180_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload === null || typeof payload !== "object") {
    throw new Error(`VLM OCR 服务错误 (HTTP ${response.status})`);
  }
  const text = String(payload?.choices?.[0]?.message?.content ?? "").trim();
  return { text, confidence: text === "" ? 0 : 85 };
}

/**
 * 逐页 VLM 识别（顺序 + 小间隔）。
 * @param {Array<{ data: Buffer }>} pages - JPEG 页面。
 * @param {{ base: string, key: string, model: string }} options
 * @returns {Promise<Array<{ text: string, confidence: number }>>}
 */
export async function vlmOcrPages(pages, options) {
  const results = [];
  for (let index = 0; index < pages.length; index += 1) {
    results.push(await vlmOcrPage(pages[index].data, options));
    if (index < pages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return results;
}
