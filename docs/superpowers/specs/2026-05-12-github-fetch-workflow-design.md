# GitHub 抓取与本地处理流程拆分设计

## 背景

当前 GUI 中，GitHub 地址模式和“生成 HTML / PDF”按钮绑定在一起。用户点击后，后端会执行完整流程：抓取 Markdown、固化远程图片资源、写出本地 Markdown、生成 HTML、再导出 PDF。

这与用户当前的真实使用方式不一致。用户希望把流程明确拆成两段：

1. GitHub 地址只负责抓取并固化资源，生成本地 Markdown。
2. 本地 Markdown 再分别执行清理、翻译和 HTML/PDF 导出。

## 目标

- GitHub 模式下只保留一个动作：`抓取并生成本地 Markdown`
- 本地模式下继续保留：`清理 Markdown`、`翻译成中文`、`生成 HTML / PDF`
- GitHub 模式执行完成后，仅展示生成成功和 Markdown 链接，不自动切到本地模式
- 后端接口语义清晰，避免继续把“抓取 Markdown”和“导出 HTML/PDF”混成一个 API 动作

## 非目标

- 不改动现有清理规则系统
- 不改动现有翻译器引擎或导出 HTML/PDF 的视觉样式
- 不新增自动串联流程，例如“抓取完自动清理”或“抓取完自动翻译”

## 方案

### 前端交互

- GitHub 模式：
  - 隐藏本地模式的三个按钮
  - 显示单独按钮：`抓取并生成本地 Markdown`
  - 结果区重点更新 Markdown 链接
- 本地模式：
  - 显示现有三个按钮：`清理 Markdown`、`翻译成中文`、`生成 HTML / PDF`
  - GitHub 单按钮隐藏

### 后端接口

- 保留现有 `/api/export`
  - 只负责从本地 Markdown 生成 HTML/PDF
- 新增 `/api/fetch-markdown`
  - 输入：GitHub Markdown URL、输出目录、语言等抓取参数
  - 输出：本地 Markdown 路径、图片下载统计、来源 URL

### 脚本职责拆分

- 现有 `scripts/export-awesome-gpt-image-pdf.mjs` 拆成两段能力：
  - `抓取并固化资源 -> 生成本地 Markdown`
  - `从本地 Markdown -> 生成 HTML / PDF`
- CLI 继续保留原有完整功能，但内部实现改为复用拆分后的基础函数

## 数据流

### GitHub 模式

1. 前端提交 GitHub URL 到 `/api/fetch-markdown`
2. 后端解析 GitHub Raw Markdown URL
3. 后端下载 Markdown、下载远程图片、改写资源路径
4. 后端写出本地 Markdown
5. 返回 Markdown 链接和下载统计

### 本地模式

1. 用户从下拉框或输入框选择本地 Markdown
2. 清理、翻译、导出各自调用独立接口
3. 输出各自动作对应的结果文件

## 错误处理

- GitHub URL 无法解析 Raw 链接时，直接返回接口错误
- 图片下载失败时，沿用当前失败策略，不吞错误
- 本地模式下如果没有 `inputPath`，继续保留当前前端校验

## 测试策略

- 单元测试：
  - Markdown-only 物化步骤不会生成 HTML/PDF
  - HTML/PDF 导出步骤可以在已有本地 Markdown 基础上单独运行
- 冒烟验证：
  - GitHub 模式按钮只显示一个
  - 本地模式按钮显示三个
  - `/api/fetch-markdown` 返回 Markdown 路径
  - `/api/export` 继续返回 HTML/PDF 路径

## 风险与取舍

- 需要改动导出脚本的内部结构，但不需要推翻现有逻辑
- GUI 会多一层模式切换显示逻辑，但可读性反而更好
- 若继续复用旧 `/api/export` 处理 GitHub 模式，短期代码少，但长期语义会变脏，因此不采用
