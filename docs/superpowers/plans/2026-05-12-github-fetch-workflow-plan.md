# GitHub Fetch Workflow Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GitHub 地址模式改为“只抓取并生成本地 Markdown”，把清理、翻译、HTML/PDF 导出保留在本地模式里。

**Architecture:** 拆出新的 `/api/fetch-markdown` 后端入口，并把导出脚本内部重构为“Markdown 物化”和“HTML/PDF 导出”两个阶段。前端根据模式切换按钮区，GitHub 模式仅暴露抓取动作，本地模式暴露原有三动作。

**Tech Stack:** Node.js ESM, 原生 `node:test`, 现有轻量 HTTP GUI, Playwright PDF 渲染

---

### Task 1: 为后端流程拆分补失败测试

**Files:**
- Create: `D:\AIPainting\PDFToMarkDown\tests\export-workflow.test.mjs`
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\export-awesome-gpt-image-pdf.mjs`
- Test: `D:\AIPainting\PDFToMarkDown\tests\export-workflow.test.mjs`

- [ ] **Step 1: 编写失败测试，要求 Markdown-only 步骤不生成 HTML/PDF**

```javascript
test('materializeMarkdownBundle 只写出 markdown 文件', async () => {
  // 调用新函数后应只存在 markdownPath，不应生成 html/pdf 文件
});
```

- [ ] **Step 2: 编写失败测试，要求 HTML/PDF 步骤可从本地 Markdown 单独运行**

```javascript
test('renderMarkdownArtifacts 从本地 markdown 生成 html/pdf', async () => {
  // 使用注入的假 pdf 渲染器，验证 html/pdf 路径被创建
});
```

- [ ] **Step 3: 运行测试，确认当前实现失败**

Run: `npm test -- --test-name-pattern="Markdown-only|html/pdf"`
Expected: FAIL，原因是新函数尚不存在。

### Task 2: 重构导出脚本，拆分“抓取 Markdown”和“导出 HTML/PDF”

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\export-awesome-gpt-image-pdf.mjs`
- Test: `D:\AIPainting\PDFToMarkDown\tests\export-workflow.test.mjs`

- [ ] **Step 1: 抽出 Markdown bundle 物化函数**
- [ ] **Step 2: 抽出从本地 Markdown 生成 HTML/PDF 的函数**
- [ ] **Step 3: 保留 CLI 兼容行为，但内部改为复用新函数**
- [ ] **Step 4: 运行测试确认转绿**

Run: `npm test -- --test-name-pattern="Markdown-only|html/pdf"`
Expected: PASS

### Task 3: 新增 `/api/fetch-markdown` 并收紧 `/api/export`

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\scripts\gui-server.mjs`

- [ ] **Step 1: 新增 `/api/fetch-markdown`，调用 Markdown-only 物化流程**
- [ ] **Step 2: 调整 `/api/export`，仅接受本地 Markdown 渲染 HTML/PDF**
- [ ] **Step 3: 更新 `/api/config` 文案或默认行为说明**

### Task 4: 修改 GUI 模式切换与按钮区

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\gui\index.html`
- Modify: `D:\AIPainting\PDFToMarkDown\gui\app.js`

- [ ] **Step 1: GitHub 模式显示单按钮“抓取并生成本地 Markdown”**
- [ ] **Step 2: 本地模式显示原有三个按钮**
- [ ] **Step 3: GitHub 模式提交改为请求 `/api/fetch-markdown`**
- [ ] **Step 4: 成功后只展示 Markdown 链接，不自动切模式**

### Task 5: 文档与验证

**Files:**
- Modify: `D:\AIPainting\PDFToMarkDown\README.md`

- [ ] **Step 1: 更新 README 的 GUI 工作流说明**
- [ ] **Step 2: 运行完整测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: 冒烟验证 GUI 接口**

Run: `Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3210/api/config'`
Expected: 返回 200

- [ ] **Step 4: 做 review 式检查**

Run: `rg -n "TODO|TBD|PLACEHOLDER" scripts gui README.md tests`
Expected: 无新增占位符残留
