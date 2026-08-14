# dsh-attachment-formats — Attachment Format Expansion (Codex-style)

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.5.0-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--attachment--formats-181717)](https://github.com/linkingoscar/dsh-attachment-formats)

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web plugin that
makes the composer accept many more attachment formats, Codex-style. Zero core-package
changes: a pure plugin that reuses the harness-native image draft rail, upload limits,
history rendering and model request pipeline.

## Supported formats

| File | Handling | Destination |
| --- | --- | --- |
| PNG / JPEG / WebP / GIF | native pipeline (plugin not involved) | image draft rail (native) |
| **PDF (with text layer)** | text-layer extraction (≤40 pages via the pymupdf4llm high-fidelity engine; larger/unavailable falls back to pdfjs) | full text on a **document card** (merged on send); over-limit → workspace spill + index card |
| **PDF (scanned / no text layer)** | tesseract.js OCR (accepted only at confidence ≥45), falls back to page images | OCR success → text channel; failure → image draft rail (vision models only) |
| **Word (.docx) / Excel (.xlsx) / PPT (.pptx)** | text extraction | document card (merged on send); over-limit → spill + index card |
| txt / md / json / code | read in the browser (UTF-8, GB18030 fallback) | document card (merged on send); over-limit → spill + index card |
| BMP / ICO / AVIF / SVG etc. | browser decode → canvas → PNG | native image draft rail |
| TIFF / legacy .doc / audio-video | — (not yet supported; explicit notice, skipped) | — |

## Document cards (Codex-style mounting, composer stays clean)

Text-like attachments that are dragged in or picked are **not stuffed into the input
box**: their content mounts as a **document card** above the composer (file name +
character count + full-text/index label, individually removable), while images keep
flowing into the native image draft rail. You type normally, and **at the moment of
sending** the plugin merges the card content into the message (with
`[attachment: <file name>]` provenance markers) before the native submit — your prompt
always stays on top and no content is lost:

- each card has a **send** button: send documents even without typing anything;
- pressing Enter / the native send button merges the cards first, then submits;
- cards are not merged while the model is mid-reply (they stay put for later).

## Long documents (index-card mode, never silently truncated)

Text beyond 80k characters and long multi-page PDFs are **not stuffed into the message**.
Instead:

1. the host spills them into the session workspace `.dsh-attachments/<sha-8>/`
   (content-addressed, reused on re-drop, auto-cleaned after 7 days):
   - `doc.md` — PDF text layer assembled per page (leading `<!-- pN -->` markers),
     Office-extracted text, long text as-is (long JSON is prettified to `doc.json`);
   - `pages/pNN.png` — rendered page images (≤100 pages, for vision models via
     `read_image`);
   - `manifest.json` — source, page/line/char counts, engine;
   - `INDEX.md` (cache root) — the aggregated list of every spilled document in this
     workspace.
2. the message carries only a few-hundred-token **index card**: page/line/char counts,
   an outline (PDF heading heuristics, md headings, JSON first-level key tree) and
   reading pointers.
3. the model reads page-by-page with the stock `read` tool (offset/limit, line numbers
   as coordinates) — full summaries read through (no dropped tails), targeted lookups
   jump by outline; missing content is an explicit tool failure, never silent loss.

Design rationale and evidence: `docs/design-longdoc.md`; comparison with similar work:
`docs/alternatives.md`.

## Engines & OCR (v3)

- **PDF text engine**: `auto` (default) → the venv's pymupdf4llm for ≤40 pages
  (high-fidelity tables/headings); pdfjs (seconds) for larger documents or when the
  venv is missing. Env: `DSH_ATTACH_ENGINE=auto|python|builtin`.
- **Scanned-PDF OCR**: python (PyMuPDF, needs system tesseract) → tesseract.js (pure JS;
  first use downloads the ~24MB eng/chi_sim language data into `vendor/tessdata/`).
  Confidence below 45 falls back to page images with a clear reason. Env:
  `DSH_ATTACH_OCR=auto|tesseract-js|off`.

## Context adaptation & full-text command (v2b)

- **Adaptive merge limit**: the client reads the token-meter `contextPressure` projection
  (model context window × current usage); the full-text merge limit becomes
  min(80k chars, headroom × 1.5) — when headroom is short, the card automatically turns
  into an index card with a status-bar note, so merged content can never blow up the
  context and get silently truncated by the API. A missing projection falls back to the
  fixed 80k threshold.
- **`/attach` command** (composer slash menu, host-registered):
  - `/attach list` — list the spilled documents in this workspace (id/name/size/engine);
  - `/attach full <id|name>` — merge the full text into model context as a next-step
    message (**takes effect on the next message**, current turn untouched); 300k-char cap
    with an explicit truncation notice — never silent loss. `read` still works afterwards
    for line-precise lookup.

## Interactions

- **Paperclip button**: composer tool row (`conversation.input.left`), opens a
  multi-select file picker whose `accept` list covers every format in the table above.
- **Drag & drop**: drop a PDF / Office / text file anywhere on the page.
- **Paste**: copy a file and Ctrl+V into the composer (or the whole page).

Native image drag/paste stays on the harness built-in pipeline; when a single drop mixes
other formats in, the plugin takes over the whole batch (converts first, then hands the
produced images back to the built-in draft rail as a "synthetic drop").

## Architecture

```
dsh-attachment-formats/
├── lib/
│   ├── index.js          # host half: POST /api/attach-formats/convert + engine routing
│   ├── client.js         # browser half: button/drop interception/synthetic drop/text injection/status bar
│   ├── cache.js          # workspace .dsh-attachments spill/manifest/INDEX.md/cleanup
│   ├── py/pymupdf4llm_convert.py  # venv high-fidelity engine (subprocess call)
│   └── convert/
│       ├── util.js       # magic-byte sniffing, base64, limit fallbacks, truncation
│       ├── provider.js   # engine detection (venv python/pymupdf4llm) + subprocess bridge
│       ├── pdftext.js    # pdfjs text-layer extraction: line assembly/header-footer dedup/heading heuristics
│       ├── outline.js    # md heading outline, JSON first-level key tree
│       ├── ocr.js        # tesseract.js OCR (traineddata download cache/confidence)
│       ├── pdf.js        # pdfjs-dist + @napi-rs/canvas → PNG/JPEG pages
│       ├── docx.js       # mammoth → plain text
│       ├── xlsx.js       # exceljs → tab-separated text
│       └── pptx.js       # jszip + a:t text runs → per-slide text
├── .venv/                # (optional) pymupdf4llm engine (generated by setup, not committed)
├── vendor/tessdata/      # OCR language-data cache (downloaded on first use, not committed)
├── docs/                 # design-longdoc.md / alternatives.md
├── scripts/smoke-*.mjs   # four offline smoke suites (converters/router/client/OCR)
└── cordis.patch.yml
```

- The host route re-sniffs magic bytes and never trusts the client-declared kind; 160MB
  request cap and 64MB per-file cap; `cwd` is read by the client from session state and
  sent with the request (it decides where the spill lands).
- Tiered thresholds: full-text merge cap 80k chars (v2b lowers it adaptively by context
  headroom); spill page images ≤100 pages (1100px wide; PNG over the per-image byte
  budget falls back to JPEG); scanned-page image cap follows the deployment limit; OCR
  ≤20 pages per run (2000px wide), confidence <45 falls back to page images.
- Document-card content is merged into the React controlled input through a DOM event
  bridge at send time (same path as the native submit); the image path is fully
  independent and untouched.
- Conversion progress/errors show in a temporary status bar above the composer
  (`conversation.input.dock`); success auto-hides after 6s, errors can be dismissed.

## Installation

From GitHub (recommended):

```powershell
dsh plugin --profile web add github:linkingoscar/dsh-attachment-formats
```

Local development:

```powershell
cd path\to\dsh-attachment-formats
npm install            # host dependencies (first time)
# optional: high-fidelity PDF engine (pymupdf4llm, self-contained venv)
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install pymupdf4llm
npm run smoke          # offline smoke tests (optional)
dsh plugin --profile web add link:path\to\dsh-attachment-formats
```

Restart `dsh web` (close the page → the desktop shortcut auto-restarts, or re-run
`dsh web`) and refresh the browser. OCR language data downloads automatically on the
first scanned-PDF recognition (≈24MB, cached in `vendor/tessdata/`, offline-ready
afterwards).

## Known limitations

- OCR (tesseract.js) quality is limited on low-resolution scans and complex tables;
  insufficient confidence falls back to page images with an explicit note — garbled text
  is never injected. Higher-quality OCR (MinerU/PaddleOCR) can be added as pluggable
  backends later.
- The pymupdf4llm high-fidelity engine handles ≤40-page PDFs only (larger documents use
  the fast pdfjs engine); table/formula reconstruction is good but not typesetting-grade
  — layout details can be cross-checked against page images.
- Scanned PDFs without a text layer can only go the page-image route when OCR is
  unavailable or fails (vision models can read them).
- DOCX tables are output cell-by-cell in reading order (no grid layout); formulas and
  images are not extracted.
- XLSX outputs displayed text/results only; charts and comments are not extracted.
- Heading/outline heuristics are best-effort: documents without strong font-size
  distinction get a weaker outline — the index card still carries line/page counts and
  reading pointers.
- TIFF, legacy .doc, iWork and archives are not converted yet.
- The "merge on send" for document cards bridges into the React controlled input over
  DOM events — an adaptation to an unpublished harness API; if a core upgrade breaks it,
  the symptom is "card content didn't enter the message", and the card's **send** button
  is the fallback (synthetic Enter path). The image path is never affected.

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)
