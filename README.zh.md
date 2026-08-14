# dsh-attachment-formats — 附件格式扩展（Codex 风格兼容）

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.5.0-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--attachment--formats-181717)](https://github.com/linkingoscar/dsh-attachment-formats)

让 DeepSeek Harness Web 的输入框像 Codex 一样接收更多文件格式。不改动任何
核心包：纯插件实现，沿用 Harness 原生的图片草稿栏、上传限额校验、历史渲染
与模型请求管道。

[English](README.md) | 中文

## 支持的格式

| 文件 | 处理方式 | 去向 |
| --- | --- | --- |
| PNG / JPEG / WebP / GIF | 原生管线，本插件不介入 | 图片草稿栏（原生） |
| **PDF（有文本层）** | 文字层提取（≤40 页用 pymupdf4llm 高保真引擎，更大/不可用时 pdfjs 兜底） | 全文挂**文档卡片**（发送时并入消息）；超限转存工作区 + 索引卡片 |
| **PDF（扫描件/无文本层）** | tesseract.js OCR（置信度 ≥45 才采用），失败回退页面图 | OCR 成功走文本通道；失败 → 图片草稿栏（仅视觉模型） |
| **Word (.docx) / Excel (.xlsx) / PPT (.pptx)** | 提取文本 | 文档卡片（发送时并入）；超限转存 + 索引卡片 |
| txt / md / json / 代码等 | 浏览器本地读取（UTF-8，回退 GB18030） | 文档卡片（发送时并入）；超限转存 + 索引卡片 |
| BMP / ICO / AVIF / SVG 等 | 浏览器解码后画布转 PNG | 原生图片草稿栏 |
| TIFF / 旧 .doc / 音视频等 | —（暂不支持，明确提示并跳过） | — |

## 文档卡片（Codex 式挂载，输入框保持干净）

拖入/选择的**文本类附件不会塞进输入框**：内容挂成输入框上方的一枚**文档卡片**
（文件名 + 字符数 + 全文/索引标签，可单独移除），图片照旧进原生图片草稿栏。
你正常在输入框打字提问，**发送瞬间**插件把卡片内容并入消息（带
`[附件: 文件名]` 出处标记）再走原生提交——提问位置永远在最上面，内容也
一字不丢：

- 卡片条自带**发送**按钮：只挂文档不输入文字也能一键发出；
- 按 Enter / 点原生发送按钮：卡片自动并入后再提交；
- 模型忙于回复时不会合并（卡片保留，稍后再发）。

## 长文档（索引卡模式，永不静默截断）

超过 8 万字符的文本、多页长 PDF：**不塞进消息**，而是

1. 主机端转存到会话工作区 `.dsh-attachments/<sha-8>/`（内容寻址，重复拖入
   复用；7 天未用自动清理）：
   - `doc.md` —— PDF 文字层按页组装（页首 `<!-- pN -->` 页码标记）、
     Office 提取文本、长文本原样（长 JSON 自动格式化落盘为 `doc.json`）；
   - `pages/pNN.png` —— 页面渲染图（≤100 页，视觉模型用 `read_image` 补充
     查看版式/图表）；
   - `manifest.json` —— 来源、页数、行数、字符数、引擎；
   - `INDEX.md`（缓存根）—— 本工作区全部已转存文档的聚合清单。
2. 消息里只挂一张几百 token 的**索引卡片**：页/行/字符数、大纲（PDF 标题粗检、
   md 标题、JSON 第一层键树）、以及读取指引。
3. 模型用 DSH 现成 `read` 工具分页读取（offset/limit，行号即出处坐标）——
   总结全文就逐段读完（不丢尾部），查细节就按大纲跳读；缺内容时是显式的
   工具失败，不会静默丢失。

设计取舍与业界取证见 `docs/design-longdoc.md`；同类作品比对见
`docs/alternatives.md`。

## 引擎与 OCR（v3）

- **PDF 文本引擎**：auto（默认）→ ≤40 页用 venv 内 pymupdf4llm（表格/标题
  高保真），更大文档或 venv 缺失时 pdfjs（秒级）。env：`DSH_ATTACH_ENGINE=
  auto|python|builtin`。
- **扫描件 OCR**：python（PyMuPDF，需系统 tesseract）→ tesseract.js（纯 JS，
  首次使用下载 eng/chi_sim 语言包 ~24MB 缓存到 `vendor/tessdata/`）。
  置信度 <45 时自动回退页面图并说明原因。env：`DSH_ATTACH_OCR=
  auto|tesseract-js|off`。

## 上下文自适应与全文命令（v2b）

- **自适应并入上限**：客户端读 token-meter 的 `contextPressure` 投影
  （模型上下文窗口 × 当前占用），全文卡片并入上限 = min(8 万字符, 余量×1.5)——
  余量不足时自动转索引卡并在状态条说明，从源头杜绝"并入顶爆上下文被
  API 静默截尾"；投影缺失时回退固定 8 万阈值。
- **`/attach` 命令**（输入框斜杠菜单，主机端注册）：
  - `/attach list` —— 列出本工作区已转存文档（id/名称/规模/引擎）；
  - `/attach full <id|名称>` —— 把全文作为 next-step 消息并入模型上下文
    （**下一条消息生效**，不打断当前对话）；上限 30 万字符，超限显式截断
    说明，绝不静默丢内容。之后仍可用 `read` 工具按行精读定位。

## 交互入口

- **回形针按钮**：输入栏工具行（`conversation.input.left`），打开文件选择器，
  支持多选；`accept` 列表覆盖上表全部格式。
- **拖放**：把 PDF / Office / 文本文件直接拖到页面任意位置。
- **粘贴**：复制文件后 Ctrl+V 到输入框（或整页粘贴）。

原生图片拖放/粘贴仍由 Harness 内建管线处理；只要一次拖放里混入其它格式，
本插件接管整个批次（先转换，再以「合成 drop」把产出的图片交还给内建草稿栏）。

## 架构

```
projects/dsh-attachment-formats/
├── lib/
│   ├── index.js          # 主机半区：POST /api/attach-formats/convert + 引擎路由
│   ├── client.js         # 浏览器半区：按钮/拖放拦截/合成 drop/文本注入/状态条
│   ├── cache.js          # 工作区 .dsh-attachments 落盘/manifest/INDEX.md/清理
│   ├── py/pymupdf4llm_convert.py  # venv 高保真引擎（子进程调用）
│   └── convert/
│       ├── util.js       # 魔数嗅探、base64、限额回退、文本截断
│       ├── provider.js   # 引擎探测（venv python/pymupdf4llm）+ 子进程桥
│       ├── pdftext.js    # pdfjs 文字层提取：行组装/页眉页脚去重/标题粗检
│       ├── outline.js    # md 标题大纲、JSON 第一层键树
│       ├── ocr.js        # tesseract.js OCR（traineddata 下载缓存/置信度）
│       ├── pdf.js        # pdfjs-dist + @napi-rs/canvas → PNG/JPEG 页
│       ├── docx.js       # mammoth → 纯文本
│       ├── xlsx.js       # exceljs → 制表符文本
│       └── pptx.js       # jszip + a:t 文本运行 → 每页文本
├── .venv/                # （可选）pymupdf4llm 高保真引擎（setup 生成，不入库）
├── vendor/tessdata/      # OCR 语言包缓存（首次使用下载，不入库）
├── docs/                 # design-longdoc.md / alternatives.md
├── scripts/smoke-*.mjs   # 四套离线冒烟（转换器/路由/客户端/OCR）
└── cordis.patch.yml
```

- 主机路由重新嗅探魔数，不信任客户端声明的 kind；请求体 160MB 上限、单文件
  64MB 上限；`cwd` 由客户端从会话状态读取后随请求上报（决定缓存落盘位置）。
- 分级阈值：全文卡片并入上限 8 万字符（v2b 按上下文余量自适应压低）；缓存
  页图 ≤100 页（1100px 宽，PNG 超单图字节预算回退 JPEG）；扫描件页图上限
  沿用部署限额；OCR 单次 ≤20 页（2000px 宽），置信度 <45 回退页面图。
- 文档卡片内容在发送瞬间经 DOM 事件桥合并进 React 受控输入框（与原生提交
  同路径）；图片路径完全独立、不受影响。
- 转换进度/错误显示在输入框上方的临时状态条（`conversation.input.dock`），
  成功 6 秒后自动消失，错误可手动关闭。

## 安装

从 GitHub 安装（推荐）：

```powershell
dsh plugin --profile web add github:linkingoscar/dsh-attachment-formats
```

本地开发安装：

```powershell
cd path\to\dsh-attachment-formats
npm install            # 安装主机端依赖（首次）
# 可选：高保真 PDF 引擎（pymupdf4llm，venv 自包含）
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install pymupdf4llm
npm run smoke          # 离线冒烟测试（可选）
dsh plugin --profile web add link:path\to\dsh-attachment-formats
```

重启 `dsh web`（关闭页面 → 快捷方式自动重启，或重新运行 `dsh web`），刷新
浏览器页面后生效。OCR 语言包在第一次识别扫描件时自动下载（约 24MB，缓存于
`vendor/tessdata/`，之后离线可用）。

## 已知限制

- OCR（tesseract.js）对低清扫描件、复杂表格质量有限；置信度不足会自动回退
  页面图并明确说明，绝不注入乱码文本。高质量 OCR（MinerU/PaddleOCR）可作为
  后续可插拔后端。
- pymupdf4llm 高保真引擎仅处理 ≤40 页 PDF（更大用 pdfjs 快速引擎）；表格/
  公式重建质量好但仍非排版级还原，版式细节可用页面图对照。
- 无文本层且 OCR 不可用/失败的扫描件只能走页面图（视觉模型可用）。
- DOCX 表格按阅读顺序输出单元格文本，不保留网格排版；公式、图片不提取。
- XLSX 只输出「显示文本/结果」，图表、批注不提取。
- 标题粗检/大纲是启发式：无显著字号区分的文档大纲较弱，索引卡仍提供行数/
  页数与读取指引。
- TIFF、旧版 .doc、iWork、压缩包等暂不转换。
- 文档卡片的"发送时合并"走 DOM 事件桥接到 React 受控输入框，属于对
  Harness 未公开 API 的适配；核心包升级后若失效，症状是「卡片内容没进
  消息」，此时可用卡片条的**发送**按钮兜底（合成 Enter 路径），图片路径
  始终不受影响。

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)
