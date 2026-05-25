# PDFToMarkDown

这是一个面向 Markdown 工作流的本地 Web 工具集，当前拆成了 4 个可独立使用的子应用，并提供 1 个总壳入口：

- `download`：从公开 GitHub 地址批量下载 Markdown 到本地目录
- `clean`：按正则规则批量清洗 Markdown
- `translate`：批量翻译 Markdown
- `export`：批量导出 HTML / PDF
- `shell`：总壳入口，统一承载以上 4 个子应用

项目仍然保留原有 CLI 能力，同时新增了多入口 GUI。

## 功能概览

### 1. GitHub Markdown 下载

- 支持一次输入多个 GitHub Markdown 地址
- 支持自定义保存目录
- 适合先把远程 Markdown 和图片资源固化到本地，再进入后续流程

### 2. Markdown 清洗

- 先指定顶层目录并扫描其中的 Markdown 文件
- 支持多选后批量清洗
- 使用 `config/cleanup-rules.json` 中的正则规则
- 默认生成 `*.cleaned.md`

### 3. Markdown 翻译

- 先指定顶层目录并扫描其中的 Markdown 文件
- 支持多选后批量翻译
- 支持 `targetLanguage`、`model`、`concurrency`、`batchSize`、`cacheFile`
- 默认生成 `*.translated.<lang>.md`

### 4. HTML / PDF 导出

- 先指定顶层目录并扫描其中的 Markdown 文件
- 支持多选后批量导出
- 支持 `stripSources` 与 `appendLicenseNote`
- 产物为对应的 HTML 和 PDF

## 安装

```powershell
npm install
```

如果你要使用 PDF 导出能力，首次还需要安装 Playwright Chromium：

```powershell
npx playwright install chromium
```

说明：

- GUI 本身现在不再把 Playwright 安装当成启动前置条件
- 但 `export` CLI 和 GUI 导出功能仍依赖 Chromium 来生成 PDF

## GUI 用法

启动 GUI：

```powershell
npm run gui
```

Windows 下也可以直接运行：

```powershell
start-gui.bat
```

默认地址：

- 总壳：`http://127.0.0.1:3210/`
- 下载子应用：`http://127.0.0.1:3210/download`
- 清洗子应用：`http://127.0.0.1:3210/clean`
- 翻译子应用：`http://127.0.0.1:3210/translate`
- 导出子应用：`http://127.0.0.1:3210/export`

### 推荐 GUI 流程

1. 在 `download` 页批量抓取 GitHub Markdown 到本地目录。
2. 在 `clean`、`translate`、`export` 页分别指定顶层目录并扫描 Markdown。
3. 从扫描结果里多选目标文件，提交批量任务。
4. 在页面右侧查看任务状态、日志和输出摘要。

## CLI 用法

### 导出 GitHub Markdown

```powershell
node scripts/export-awesome-gpt-image-pdf.mjs --github-url "https://github.com/owner/repo/blob/main/README.md"
```

### 导出本地 Markdown

```powershell
node scripts/export-awesome-gpt-image-pdf.mjs --input output/zh-CN/README.zh-CN.md
```

### 常用导出脚本

```powershell
npm run export:zh
npm run export:en
```

### 清洗 Markdown

```powershell
node scripts/clean-markdown.mjs --input output/zh-CN/README.zh-CN.md --rules-file config/cleanup-rules.json
```

### 翻译 Markdown

```powershell
node scripts/translate-markdown.mjs --input output/zh-CN/README.zh-CN.md --api-key "你的 DeepSeek API Key"
```

带更多参数的示例：

```powershell
node scripts/translate-markdown.mjs ^
  --input output/zh-CN/README.zh-CN.md ^
  --target-lang zh-CN ^
  --model deepseek-chat ^
  --concurrency 6 ^
  --batch-size 1 ^
  --cache-file output/.translation-cache.json ^
  --api-key "你的 DeepSeek API Key"
```

## 规则文件

默认清洗规则文件：

```text
config/cleanup-rules.json
```

每条规则支持这些字段：

- `name`：规则名称
- `pattern`：正则表达式
- `flags`：正则 flags，例如 `gm`
- `replacement`：替换内容，留空表示删除
- `enabled`：是否启用

## 目录结构

```text
apps/
  download-ui/
  clean-ui/
  translate-ui/
  export-ui/
  shell-ui/
  shared/
server/
  routes/
  services/
  shared/
scripts/
config/
tests/
```

## 测试

运行全部测试：

```powershell
node --test
```

只跑 GUI 相关测试：

```powershell
npm run test:gui
```
