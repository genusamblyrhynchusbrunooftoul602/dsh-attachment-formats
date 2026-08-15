/**
 * dsh-attachment-formats — 百度 OCR 云 API（host side，v0.6）。
 *
 * 零依赖（Node fetch）。免费额度（官方"免费测试资源"页，2026-07）：
 *   通用文字识别标准版 / 高精度版：个人认证 1,000 次/月，企业 2,000 次/月。
 * 配额耗尽或调用失败时抛 BaiduQuotaError / Error，调用方回退本地
 * tesseract.js——云端只是"更高质量的可选前置"。
 *
 * 配置（env）：
 *   BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET  控制台创建的 API Key/Secret
 *   DSH_ATTACH_OCR=baidu|auto|tesseract-js|off（auto：有凭据即用百度）
 *   DSH_ATTACH_OCR_ACCURATE=1             使用高精度版（独立免费额度）
 */

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const OCR_URL = "https://aip.baidubce.com/rest/2.0/ocr/v1/";
/** 免费额度相关错误码（官方错误码表）。 */
const QUOTA_CODES = new Set([4, 17, 18, 19]);
/** token 缓存（expires_in 约 30 天，提前 5 天刷新）。 */
let tokenCache = { at: 0, token: null, key: "" };

export class BaiduQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaiduQuotaError";
    this.code = "QUOTA";
  }
}

/**
 * 获取 access_token（进程内缓存，失败抛错）。
 * @param {string} apiKey - 控制台 API Key。
 * @param {string} secretKey - 控制台 Secret Key。
 * @param {typeof fetch} [fetchLike] - 测试注入。
 */
export async function baiduAccessToken(apiKey, secretKey, fetchLike = fetch) {
  const key = `${apiKey}:${secretKey}`;
  const now = Date.now();
  if (tokenCache.key === key && tokenCache.token !== null && now - tokenCache.at < 25 * 24 * 3600 * 1000) {
    return tokenCache.token;
  }
  const response = await fetchLike(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: apiKey,
      client_secret: secretKey
    })
  });
  const payload = await response.json();
  if (typeof payload?.access_token !== "string") {
    throw new Error(`百度 OCR 鉴权失败: ${payload?.error_description ?? payload?.error ?? "unknown"}`);
  }
  tokenCache = { at: now, token: payload.access_token, key };
  return payload.access_token;
}

/**
 * 识别一页 JPEG（base64 表单）。返回文本与平均置信度（0-100）。
 */
export async function baiduOcrPage(jpegBuffer, { token, accurate = false, fetchLike = fetch }) {
  const body = new URLSearchParams({
    image: jpegBuffer.toString("base64"),
    language_type: "CHN_ENG",
    detect_direction: "false",
    probability: "true"
  });
  const endpoint = accurate ? "accurate_basic" : "general_basic";
  const response = await fetchLike(`${OCR_URL}${endpoint}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json();
  if (payload?.error_code !== undefined && payload?.error_code !== null) {
    const message = `百度 OCR 错误 ${payload.error_code}: ${payload.error_msg ?? ""}`;
    if (QUOTA_CODES.has(payload.error_code)) throw new BaiduQuotaError(message);
    throw new Error(message);
  }
  const words = Array.isArray(payload?.words_result) ? payload.words_result : [];
  const text = words.map((word) => word?.words ?? "").filter((line) => line !== "").join("\n");
  const probabilities = words
    .filter((word) => word?.probability && Number.isFinite(word.probability.average))
    .map((word) => word.probability.average);
  const confidence = probabilities.length > 0
    ? (probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length) * 100
    : 85; // 接口未返回概率时的保守默认
  return { text, confidence };
}

/**
 * 逐页识别（顺序 + 小间隔，尊重免费档 QPS）。
 * @param {Array<{ data: Buffer }>} pages - JPEG 页面。
 * @param {{ apiKey: string, secretKey: string, accurate?: boolean, fetchLike?: typeof fetch }} options
 * @returns {Promise<Array<{ text: string, confidence: number }>>}
 */
export async function baiduOcrPages(pages, options) {
  const fetchLike = options.fetchLike ?? fetch;
  const token = await baiduAccessToken(options.apiKey, options.secretKey, fetchLike);
  const results = [];
  for (let index = 0; index < pages.length; index += 1) {
    results.push(await baiduOcrPage(pages[index].data, {
      token,
      accurate: options.accurate === true,
      fetchLike
    }));
    if (index < pages.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 400)); // QPS 保护
    }
  }
  return results;
}
