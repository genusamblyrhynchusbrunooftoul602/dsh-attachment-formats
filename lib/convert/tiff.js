/**
 * dsh-attachment-formats — TIFF → PNG（host side，v0.6 P0）。
 *
 * sharp（libvips 预编译）解码 TIFF，支持多页（逐页转 PNG，上限 20 页），
 * 输出进入原生图片草稿栏。
 */
import sharp from "sharp";

/** 单次 TIFF 转换的最大页数。 */
export const TIFF_PAGE_CAP = 20;

/**
 * 把编码 TIFF 逐页渲染为 PNG。
 * @param {Buffer} bytes - TIFF 字节。
 * @returns {Promise<{ pages: Array<{ data: Buffer, mediaType: "image/png", width: number, height: number }>, total: number, rendered: number }>}
 */
export async function tiffToPngPages(bytes) {
  const image = sharp(bytes, { limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== "tiff") throw new Error("不是有效的 TIFF 文件");
  const total = Math.max(1, metadata.pages ?? 1);
  const rendered = Math.min(total, TIFF_PAGE_CAP);
  const pages = [];
  for (let page = 0; page < rendered; page += 1) {
    const buffer = await sharp(bytes, { page, limitInputPixels: 100_000_000 })
      .rotate() // 尊重 EXIF 方向
      .png()
      .toBuffer();
    const info = await sharp(buffer).metadata();
    pages.push({
      data: buffer,
      mediaType: "image/png",
      width: info.width ?? 0,
      height: info.height ?? 0
    });
  }
  return { pages, total, rendered };
}
