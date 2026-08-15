# 长文档附件方案（v2 设计稿）

> **状态**：v2a + v3 + v2b 已实现（插件 v0.6）——PDF 文字层提取与分级、
> 工作区 `.dsh-attachments` 落盘 + manifest + 聚合 INDEX.md、索引卡注入、
> 长 JSON 键树 / md 大纲、扫描件回退页图；v3：pymupdf4llm 高保真引擎
> （venv 子进程，≤40 页）、tesseract.js OCR（置信度门控 45）；v2b：
> `/attach list|full` 全文命令（next-step 收件箱注入）与上下文余量感知的
> 自适应并入上限（token-meter contextPressure 投影）。v0.6 起文本附件改为
> **Codex 式文档卡片挂载**（输入框保持干净，发送瞬间合并进消息），并新增
> 格式覆盖、云 OCR、转换缓存与工作区零拷贝（见 docs/upgrade-v6.md）。
> 高质量 OCR 后端（MinerU/PaddleOCR）作为可插拔扩展点预留。
> 测试：`npm run smoke:all`（五套冒烟），并在真实 21 页论文、320 页手册、
> 扫描成绩单上验证。
>
> 回应的问题：v1 把 PDF 渲染成图、把长文本直插草稿，面对多页图文论文、
> 长 md/json 时能不能保证不丢上下文？
>
> **结论先行**：不能保证，且有一个比"丢上下文"更硬的约束——DeepSeek
> 文本模型路线会**直接拒绝图片内容**。正确方向是业界一致的"小内容全量、
> 大内容索引 + 工具按需分页读取"，DSH 现有的 `read`/`read_image` 工具
> 已经具备全部读取能力，本方案只做"转换 + 落盘 + 索引卡片"，零核心改动。

## 1. v1 现状与风险复盘

v1 实际上不是"全都渲染成图"，而是三条通道：

| 通道 | 处理 | 上限 | 风险 |
| --- | --- | --- | --- |
| 原生图片 | 直入图片草稿栏 | 5MB/张、20 张/条 | 无（沿用内建） |
| PDF | 逐页渲染 PNG/JPEG | 20 页硬截断 | **截断丢尾部**、小字/公式/表格视觉读取有损、每页 ~1.3k+ token、**文本模型路线直接报错** |
| 文本类/Office | 提取文本直插草稿 | 300k 字符 | 超长截断、单条消息塞爆请求上限被 API 静默截断、污染 KV cache、无法分页引用 |

三个真实风险，按严重度：

1. **模型路线硬约束（最严重）**：`@deepseek-ai/dsh-llm-deepseek` 适配器对含
   图片的内容直接抛 `UNSUPPORTED_CONTENT`（"The DeepSeek chat-completions
   adapter does not support image content."）。即默认 deepseek-v4-pro 下，
   PDF→图 的产物根本发不出去；`read_image` 工具同样被模型 image 输入声明
   门控。图通道只有视觉模型路线（如 pi-ai 网关的视觉模型）可用。
2. **截断无提示**：20 页硬截断只给一行警告；300k 字符直插超请求上限时
   API 侧截断，模型看到的文本缺尾部且不知道缺了。
3. **不可引用、不可分页**：整块塞进草稿后没有"第几页/第几行"坐标，模型
   想复核细节只能重读全部，长文档下必然溢出。

## 2. 业界取证（GitHub / 官方仓库）

### 2.1 Codex CLI（openai/codex，main 分支实证）

- **附件只收图片，没有 PDF 处理代码**。仓库树递归搜索 `pdf` 无任何命中；
  `codex-rs/tui/.../attachment_state.rs` 只管理 local images + remote image
  URLs。官方文档 [Image inputs](https://learn.chatgpt.com/docs/image-inputs.md?surface=cli)
  也只讲 PNG/JPEG。
- 图片有 token 预算式降采样：`codex-rs/core/src/image_preparation.rs` 中
  `HIGH_DETAIL_LIMITS`（max_dimension 2048 / max_patches 2500）与
  `UNIFIED_IMAGE_LIMITS`（6000 / 10000），并在消息里注入 resize 提示。
- **长文本的答案是"工具分页读取"，不是塞进提示词**：Codex 的 read 工具
  带 offset/limit；拖拽非图片文件至今是 open issue
  [openai/codex#3761](https://github.com/openai/codex/issues/3761)。

### 2.2 Claude Code（anthropics/claude-code）

- read 工具支持 PDF：内部用 `pdftoppm`（poppler）转页图（见
  [issue #65089](https://github.com/anthropics/claude-code/issues/65089)
  的 Windows 沙箱问题佐证）。同样是"工具读文档"而非附件直塞。

### 2.3 社区 skills：主流是"PDF → Markdown 再喂模型"

- [jseook11/codex-pdf-ocr-to-markdown-skill](https://github.com/jseook11/codex-pdf-ocr-to-markdown-skill)（OCR 转 Markdown）
- [aliceisjustplaying/claude-skill-pdf-to-markdown](https://github.com/aliceisjustplaying/claude-skill-pdf-to-markdown)
- [daymade/claude-code-skills · doc-to-markdown](https://github.com/daymade/claude-code-skills/blob/main/daymade-docs/doc-to-markdown/SKILL.md)
- RAG 工具链：[pymupdf4llm](https://github.com/pymupdf/pymupdf4llm)、
  marker、docling —— 保留标题层级、表格、公式（LaTeX）与图位置；
  五工具对比见
  [I benchmarked 5 open-source PDF to Markdown tools (2026)](https://dev.to/jeromebuilds/i-benchmarked-5-open-source-pdf-to-markdown-tools-for-rag-on-real-documents-2026-4heh)。

### 2.4 DSH 自身（决定落地成本的关键）

- `read` 工具已支持 `offset`/`limit` 分页 + 行号 + "Use offset to continue"
  页脚（`dsh-tool-fs`）——正是 Codex 式分页读取。
- `read_image` 工具已存在（PNG/JPEG/WebP/GIF），但受"当前模型声明 image
  输入"门控（`dsh-tool-fs` read-image）。
- 主机端 pdfjs-dist 文本层提取（`getTextContent`）在 v1 依赖里已可用。

**推论**：不需要发明新的读取机制。让模型用 DSH 现成的 read 工具读落盘的
转换产物，就是 Codex/Claude 同款架构，而且插件依然零核心改动。

## 3. 设计原则

1. **文字优先，图为辅**：文档的主通道是文本层（无损、省 token、文本模型
   可用）；页面图只在视觉模型路线下作为补充证据。
2. **小内容全量、大内容索引**：按"转换后文本量"分流，阈值不依赖文件字节。
3. **永不静默截断**：要么完整注入，要么明确给索引卡 + 读取路径；任何截断
   都带显式说明和出处坐标。
4. **复用原生工具**：落盘到工作区缓存目录，模型用 `read`（分页）/`read_image`
   读取，插件不注册新工具。
5. **可重生成、可清理**：转换产物带 manifest（源文件名、SHA、行数、页数、
   时间），属临时缓存，可随时删除重来。

## 4. 方案：三档分流 + 索引卡片

按转换后的文本长度分流：

| 档 | 条件 | 行为 |
| --- | --- | --- |
| T0 小文档 | ≤ 12k 字符（短 md/json/代码/小 docx） | 现状直插草稿，所见即所得 |
| T1 中型 | 12k ~ 60k 字符 | 直插全文 + 首尾出处标记；接近上限或模型上下文紧张时自动降级 T2 |
| T2 大型 | > 60k 字符，或 PDF 页数超过图片可行量 | **不直插**，走索引卡片模式 |

T2 流程（以 PDF 为例）：

1. **主机端转换**（扩展现有 `/api/attach-formats/convert`）：
   - pdfjs `getTextContent` 逐页提取文本层 → 按页组装结构化 Markdown
     （标题/段落/表格行，去重页眉页脚，页内标注页码）；
   - 每页同时渲染 PNG（沿用 v1 渲染器）作为视觉补充，仅视觉模型路线消费；
   - Office/长文本同样提取后落盘。
2. **落盘**：写入 `<workspace>/.dsh-attachments/<sha256-8>/`
   - `doc.md`（文本主通道）、`pages/p01.png …`、`manifest.json`。
3. **索引卡片注入草稿**（几百 token，不占上下文）：
   ```text
   [附件索引: 论文.pdf]
   - 全文已转存: .dsh-attachments/a1b2c3d4/doc.md（42 页 / 约 9.8 万字）
   - 大纲: 1 引言(p1) · 2 相关工作(p3) · 3 方法(p7) · 4 实验(p19) · 5 结论(p38)
   - 读取方式: 用 read 工具按 offset/limit 分页读取 doc.md（含页码标注）；
     需要看版式/图表时用 read_image 读 pages/pNN.png（需视觉模型）。
   - 引文坐标: 文件名 + 页码 + 行号，如 doc.md#p19L40
   ```
   - 长 JSON：卡片额外附第一层键树（key 名 + 元素数）；
   - 长 md：卡片附标题大纲（两级 + 行号）。
4. **模型自主决定读多少**：总结全文 → 分页读完（read 工具自带继续提示，
   不会丢尾部）；只查一处 → 按大纲跳页；缺内容时是显式工具失败而非静默
   丢失。
5. **全文模式（可选）**：卡片里提供一句"如需把全文并入上下文可回复
   '展开全文'"；v2b 用插件命令（conversationEvents 注册 `/attach full`）
   做显式全量注入。

扫描件/无文本层 PDF：回退 v1 渲染图 + 卡片说明"仅视觉模型可用"；OCR
（tesseract / 外部 API）留 v3，转换器接口预留。

## 5. 分期与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **v2a** | T2 通道：PDF 文本层提取 + 落盘 + 索引卡片；Office/长文本落盘；JSON 键树 / md 大纲；T0/T1 维持 v1 行为 | 60 页论文：草稿只有索引卡；"总结全文"时模型分页读完并引用页号；长 JSON 可按键路径查读；纯文本模型路线全程可用 |
| v2b | 上下文感知自动分流、`/attach full` 全文命令、出处跳转（doc.md#p19L40 一键读） | 同文档在两种模式下结果一致 |
| v3 | 扫描件 OCR、外部转换器可插拔（pymupdf4llm/marker 子进程）、多文档聚合索引、缓存 TTL 清理 | 扫描件可用；质量对齐 pymupdf4llm 基准 |

## 6. 风险与开放问题

- **工作区目录获取**：落盘需要会话 cwd（sessions/workspaces 服务），实现时
  确认；兜底用 `DSH_HOME/storages` + 绝对路径卡片（fs 策略可能拒绝，故
  首选工作区内）。
- **模型遵循度**：依赖模型按卡片指引调用 read。DSH 模型对工具调用已有
  训练（本会话即证明），失败模式是"读不到"显式报错，不会静默丢内容。
- **多会话共享缓存**：`.dsh-attachments` 挂在工作区下，同工作区多会话
  自然共享；manifest 按内容寻址，重复拖入同一文件复用转换结果。
- **页眉页脚去重**：文本层提取的常见噪声，v2a 用简单启发式（相邻页相同
  行去重），不追求完美。

## 附：本方案与 Codex 的对齐点

| 维度 | Codex CLI | 本方案 |
| --- | --- | --- |
| 附件本体 | 仅图片 | 图片 + 文档（转换后） |
| 长文档 | read 工具分页 | 复用 DSH read 工具分页 |
| 图片 token 预算 | 2048px/2500 patches 降采样 | 1600px 渲染上限 + 单图 5MB 预算 |
| 文档坐标 | 文件行号 | 文件 + 页码 + 行号 |
| 截断行为 | 工具读显式分页 | 索引卡 + 显式分页，绝不静默截断 |
