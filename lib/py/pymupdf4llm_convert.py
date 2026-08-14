#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-attachment-formats — pymupdf4llm 转换脚本（由 Node 子进程调用）。

用法: python pymupdf4llm_convert.py <input.pdf> <result.json>

输出 result.json:
  { "ok": true, "engine": "pymupdf4llm", "pageCount": N,
    "pages": ["page1 markdown", ...], "hasTextLayer": bool, "ocr": bool }
  { "ok": false, "error": "..." }

有文本层 → pymupdf4llm 逐页 Markdown（表格/标题保留）；
无文本层且系统装有 tesseract 时 → PyMuPDF OCR 兜底（逐页纯文本）。
"""
import json
import sys


def main():
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "usage: script.py <pdf> <out>"}))
        return 1
    pdf_path, out_path = sys.argv[1], sys.argv[2]
    result = {"ok": False, "error": "unknown failure"}
    try:
        import pymupdf4llm  # noqa: F401
        import pymupdf

        doc = pymupdf.open(pdf_path)
        page_count = doc.page_count
        pages = []
        has_text = False
        ocr = False
        try:
            chunks = pymupdf4llm.to_markdown(
                doc, page_chunks=True, write_images=False, show_progress=False
            ) or []
            # pymupdf4llm >= 1.x：page_chunks 返回逐页 dict（text 字段为 Markdown）
            pages = [
                chunk.get("text", "") if isinstance(chunk, dict) else str(chunk)
                for chunk in chunks
            ]
            has_text = sum(len(p) for p in pages) >= max(10, 10 * page_count)
        except Exception:  # 转换失败时退回逐页文本
            pages = [page.get_text("text") for page in doc]
            has_text = sum(len(p) for p in pages) >= max(10, 10 * page_count)

        if not has_text:
            # 扫描件：尝试 PyMuPDF OCR（需要系统 tesseract 二进制）
            try:
                ocr_pages = []
                for page in doc:
                    text_page = page.get_textpage_ocr()
                    ocr_pages.append(text_page.extractText())
                ocr_text = sum(len(p) for p in ocr_pages)
                if ocr_text >= max(10, 10 * page_count):
                    pages = ocr_pages
                    has_text = True
                    ocr = True
            except Exception:
                ocr = False

        result = {
            "ok": True,
            "engine": "pymupdf4llm",
            "pageCount": page_count,
            "pages": pages,
            "hasTextLayer": has_text,
            "ocr": ocr,
        }
        doc.close()
    except Exception as exc:  # noqa: BLE001
        result = {"ok": False, "error": str(exc)}
    try:
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
