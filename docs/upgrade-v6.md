# v0.6 升级调研（针对现有 limitations 的 GitHub 解决方案）

> **状态**：路线图全部落地（插件 v0.6 发布）——P0 批次（DOCX 表格保真
> turndown+GFM、TIFF sharp、epub/odt/rtf pandoc+zip 兜底、旧 .doc/.xls/.ppt
> LibreOffice、PDF 书签大纲）与 P1/P2（百度 OCR 云 API 免费额度零依赖、
> 远程 VLM OCR、外部文档解析服务 `DSH_ATTACH_DOC_SERVER`、内容自适应引擎、
> 附件缓存设置页、工作区零拷贝引用）。
> 体积约束下的取舍：RapidOCR（onnxruntime ~50MB）与 GB 级模型方案仅作
> 可选后端，不默认安装；云端 API 是 OCR 质量升级的主通道。
> 测试：`npm run smoke:p0`。
>
> 用途：为下一版本升级做选型依据。每条 limitation → 现有 GitHub 方案 →
> 接入方式（本插件是"Node 进程 + 可选 venv 子进程"架构）→ 推荐与代价。
> 外部工具一律作为**可选后端**（用户自行安装、缺失时自动降级到内置引擎），
> 保持插件本体零重依赖。

## 0. 当前 limitation 清单（v0.5 README）

1. OCR 质量有限（tesseract.js，低清扫描件/复杂表格差）
2. 版式保真度：pymupdf4llm 仅 ≤40 页、非排版级还原（多栏/公式/复杂表格）
3. 无文本层且 OCR 失败的扫描件 → 只能页面图（视觉模型）
4. DOCX 表格丢网格排版、公式/图片不提取
5. XLSX 只输出显示文本、图表/批注不提取
6. 标题/大纲启发式对无字号区分文档弱
7. TIFF、旧 .doc/.xls/.ppt、iWork、压缩包/电子书不支持
8. 大文件 base64 上传成本（路径派插件零拷贝）
9. 无上传管理 UI
10. 发送合并走 DOM 桥（对 Harness 未公开 API 的适配）

## 1. OCR 质量（limitation 1、3）

| 方案 | 仓库 | 特点 | 接入方式 | 代价 |
| --- | --- | --- | --- | --- |
| **RapidOCR** | [RapidAI/RapidOCR](https://github.com/RapidAI/RapidOCR) | ONNXRuntime 推理、无 Paddle 依赖、CPU 实时、PP-OCRv4 级精度、中英日韩 40+ 语种、模型 ~15MB | venv `pip install rapidocr-onnxruntime`，子进程输出 JSON（对齐现有 pymupdf4llm 桥） | 极小；**首选升级** |
| **PaddleOCR / PP-StructureV3** | [PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | 版面分析 + 表格结构还原 + 公式识别一体；官方 MCP server / serve API（[docs](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/integrations/mcp_server.en.md)） | 外部服务（`paddleocr serve` 或 docker），插件按 URL 调用 | 重（模型数 GB）；适合"常驻服务"用户，插件作为 HTTP 后端探测 |
| **PaddleOCR-VL-1.5** | 同上 deploy 目录 | VLM 文档解析，版面/表格/公式更强 | 外部服务 | 更重（GPU 推荐） |
| **MinerU** | [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | 复杂文档 → LLM-ready markdown/JSON；新版 MinerU2.5-1.2B 已瘦身为 1.2B 模型 | venv `pip install mineru`，子进程 `mineru -p in -o out` | 模型 ~2.5GB、CPU 慢；**AGPL-3.0**（独立进程调用不传染仓库，但分发需注意） |
| **olmOCR-2** | [allenai/olmocr](https://github.com/allenai/olmocr) | VLM 线性化扫描书/论文，质量当前顶级 | 需 GPU（CPU 不可用）；或经视觉 API（如用户的 pi-ai 网关）远程调用 | 可作为"远程 OCR provider"扩展点，本地不做 |
| **marker / surya** | [datalab-to/marker](https://github.com/datalab-to/marker) | PDF→Markdown + 图/表/公式，质量高 | venv 子进程 | 模型 GB 级、GPL-3.0 |

**推荐路线**：v0.6 先加 **RapidOCR**（轻、快、中文好，与现有 venv 桥同构），
探测顺序：RapidOCR → tesseract.js（零安装兜底）→ 页面图。PP-StructureV3 /
MinerU 作为 `DSH_ATTACH_DOC_SERVER=<url>` 外部服务探测，代码里只留 URL 适配
层。

## 2. 版式保真度与页数门限（limitation 2、6）

- **40 页门限**：是我自己的策略（python 引擎高保真 vs pdfjs 速度的取舍），
  不是 pymupdf4llm 限制。v0.6 可改为**按内容决策**：先 pdfjs 快速探测
  表格/公式密度（`getOperatorList` 里 re/绘图算子比例），表格密度高才走
  pymupdf4llm（此时页数门限放宽到 ~80）；纯文字手册继续 pdfjs 秒级。
- 大纲弱：改用**页面首行 + pymupdf4llm 自带 TOC**（`pymupdf4llm.to_markdown`
  的 toc 字段 / `doc.get_toc()` 书签目录）——比字号启发式可靠得多，书签
  缺失时回退现有启发式。

## 3. DOCX 表格与内容（limitation 4）

- **mammoth HTML → turndown + GFM 插件**：`mammoth.convertToHtml` 保留表格
  结构，[turndown](https://github.com/mixmark-io/turndown) +
  [@joplin/turndown-plugin-gfm](https://github.com/joplin/turndown-plugin-gfm)
  把表格转成 Markdown 表格（pipe 表）。两个都是纯 JS 小依赖，直接加进插件
  node_modules——**零安装成本的高价值升级**（表格保真从"丢网格"到"保留"）。
- 公式/图片：pymupdf4llm/MinerU 已能提取公式（LaTeX）；docx 内嵌公式
  （OMML）暂无纯 JS 好方案，用 pandoc 转 latex（见下）。
- **pandoc**（[jgm/pandoc](https://github.com/jgm/pandoc)）：万能文档转换器，
  docx/odt/epub/rtf → markdown（`--to=markdown+grid_tables` 表格保真），
  还能直接吃 epub/odt。独立二进制（GPL-2，外部进程无传染），探测到就作为
  docx/odt/epub/rtf 的高保真后端，缺失时回退 mammoth/jszip 内置路径。

## 4. 旧版 Office / 格式覆盖（limitation 7）

| 格式 | 方案 | 接入 |
| --- | --- | --- |
| 旧 .doc/.xls/.ppt | **LibreOffice headless**（`soffice --headless --convert-to docx|xlsx|pptx`，[Haystack 同款用法](https://github.com/deepset-ai/haystack/blob/main/docs-website/versioned_docs/version-2.26/pipeline-components/converters/libreofficefileconverter.mdx)）→ 再走现有 office 管线 | 探测 `soffice` 二进制；Windows 用户装了 WPS/Office 也可用 `soffice` 等价物（[harness-anything-mac 参考](https://github.com/yb2460/harness-anything-mac)：WPS COM/LibreOffice 双后端思路） |
| TIFF | **sharp**（libvips，预编译二进制） | 加一个 npm 依赖即可，路由 raster 分支直接 `sharp(buffer).png()` |
| zip/7z | jszip 已在内——列目录 + 逐文本文件挂卡片（或按需展开） | 纯 JS，低风险 |
| epub/mobi | epub = zip+xhtml：jszip + turndown；或 pandoc | 与 DOCX 升级共用依赖 |
| iWork (.pages/.numbers/.key) | 无可靠开源方案 | 明确提示"请导出为 PDF/Word"，不做 |

## 5. 上传成本与管理（limitation 8、9）

- **工作区文件零拷贝**：借鉴 [omdsh-dev/dsh-drag-and-drop](https://github.com/omdsh-dev/dsh-drag-and-drop)
  的"主机解析真实路径"思路——拖入的文件若能解析到工作区内路径，直接按
  `/attach full` 同款机制引用路径而非上传字节（工作区内才启用，外部文件
  仍走现有字节通道）。
- **上传管理 UI**：借鉴 [l541402398/dsh-file-uploads](https://github.com/l541402398/dsh-file-uploads)
  的设置页模式：`settings.section` 注册"附件缓存"页，列出 `.dsh-attachments`
  各文档（大小/时间/引擎），提供删除/一键清空。纯插件内功能。

## 6. 发送合并 DOM 桥的稳定性（limitation 10）

- 调研结论：Harness 客户端有更"官方"的缝——`inputTriggers.registerSource`
  （`dsh-client-ui-input-trigger`，ui-commands 的 slash 菜单同款 API）。可注册
  自有 source 承接输入触发；但 composer 草稿写入仍无公开 API，**DOM 桥在
  官方缝出现前仍是唯一通路**。v0.6 行动：把合并逻辑抽成单一适配层函数 +
  增强失败可观测性（合并后检测草稿是否更新，未更新则弹错误提示而非静默），
  并把 inputTriggers 方案记为待办（核心包升级时优先切换）。

## 7. 推荐落地顺序（v0.6）

| 优先级 | 升级 | 依赖新增 | 价值 |
| --- | --- | --- | --- |
| P0-1 | DOCX 表格保真：mammoth HTML → turndown+GFM | 2 个纯 JS 依赖 | 高（常见痛点，零安装） |
| P0-2 | TIFF：sharp | 1 个 npm 依赖 | 高 |
| P0-3 | epub/odt/rtf：pandoc 探测 + jszip/turndown 兜底 | 无/探测 | 高 |
| P0-4 | 旧 Office：LibreOffice 探测转 docx/xlsx/pptx | 探测 | 高 |
| P0-5 | 大纲升级：PDF 书签 TOC + 页面首行 | 无（pymupdf 已有 API） | 中 |
| P1-1 | OCR 升级：RapidOCR venv 后端 | venv pip | 高 |
| P1-2 | 引擎按内容决策（表格/公式密度探测） | 无 | 中 |
| P1-3 | 上传管理设置页 + 缓存清理 | 无 | 中 |
| P2-1 | 工作区文件零拷贝引用 | 无 | 中 |
| P2-2 | PP-StructureV3 / MinerU 外部服务适配层（`DSH_ATTACH_DOC_SERVER`） | 外部 | 按需 |
| P2-3 | 远程 VLM OCR provider（olmOCR-2 经视觉 API） | 外部 | 按需 |

## 8. 许可与风险备注

- RapidOCR/PaddleOCR/olmOCR：Apache-2.0；LibreOffice：MPL-2.0；
  turndown：MIT；sharp：Apache-2.0；pandoc：GPL-2+（独立二进制进程，无传染）。
- MinerU：AGPL-3.0、marker/surya：GPL-3.0 —— 作为**用户自行安装的外部进程**
  调用不构成分发，但若未来想把它们打包进插件分发，需单独评估。
- 模型体积：MinerU2.5 ~2.5GB、PaddleOCR-VL ~5GB+、olmOCR 需 GPU——全部走
  "探测到才用、缺失静默降级"模式，不影响零依赖开箱体验。
- 所有新增后端统一挂到现有 `provider.js` 探测框架，路由与分级逻辑不变。
