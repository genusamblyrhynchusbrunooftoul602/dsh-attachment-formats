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

        # v0.6 内容自适应：大文档先采样判断向量密度，纯文字文档直接跳过
        # 高保真转换（由 Node 侧回退 pdfjs 快速引擎，避免无谓的长时间转换）。
        vector_score = None
        if page_count > 40:
            sample = min(6, page_count)
            drawings = 0
            chars = 0
            try:
                for page in doc[:sample]:
                    drawings += len(page.get_drawings())
                    chars += len(page.get_text())
            except Exception:
                drawings = 0
                chars = 0
            vector_score = round(drawings / max(1, sample), 2)
            # 采样页平均 <10 个矢量对象（表格线/框图等）→ 纯文字文档
            if vector_score < 10:
                result = {
                    "ok": True,
                    "engine": "pymupdf4llm",
                    "pageCount": page_count,
                    "pages": [],
                    "hasTextLayer": False,
                    "ocr": False,
                    "toc": [],
                    "skipped": True,
                    "reason": "low-vector-density",
                    "vectorScore": vector_score,
                }
                doc.close()
                with open(out_path, "w", encoding="utf-8") as handle:
                    json.dump(result, handle, ensure_ascii=False)
                return 0

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

        # v0.6 P0：书签目录（get_toc）作为大纲优先来源
        toc = []
        try:
            for entry in doc.get_toc()[:60]:
                if len(entry) >= 3 and isinstance(entry[1], str):
                    toc.append([int(entry[0]), entry[1], int(entry[2])])
        except Exception:
            toc = []

        result = {
            "ok": True,
            "engine": "pymupdf4llm",
            "pageCount": page_count,
            "pages": pages,
            "hasTextLayer": has_text,
            "ocr": ocr,
            "toc": toc,
            "skipped": False,
            "vectorScore": vector_score,
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
