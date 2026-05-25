---
name: markdown-zh-localizer
description: Translate non-Chinese human-readable content in Markdown files into Simplified Chinese while preserving Markdown structure, links, asset paths, HTML tags, code fences, placeholders, and Chinese-majority blocks. Use for documentation, prompt collections, README files, and project Markdown localization.
---

# Markdown 中文本地化 Skill

## 何时使用

当用户要求把 Markdown / README / 文档 / 提示词合集中的非中文内容翻译为中文，同时保留原格式、链接、图片路径、代码块和项目结构时，使用本 Skill。

典型需求：

- “把这个 md 文档里的非中文翻译成中文”
- “中文里夹杂一点英文不用翻译，链接不要翻译”
- “项目文档批量翻译，生成新副本”
- “把 prompt 案例文档本地化成中文，但不要破坏代码块和路径”

## 核心原则

1. **保结构**
   - 保留 Markdown 标题层级、表格、列表、引用、代码围栏、HTML 标签、图片标签、空行。
   - 不要重排内容，不要删减案例，不要合并段落。

2. **保链接和路径**
   - 不翻译 URL。
   - 不翻译本地资源路径，例如 `assets/example.jpg`、`./docs/a.md`。
   - 不改 HTML 属性值里的链接、路径、尺寸、class、id。

3. **只翻译主要为外文的自然语言**
   - 纯英文、日文、韩文、西文等大段自然语言，翻译为简体中文。
   - 如果一大块内容主要是中文，只夹杂少量英文、品牌名、平台名、参数词，不翻译整块。
   - 专有名词优先保留，例如 TikTok、OpenAI、GPT Image、Minecraft、Apple Park、Final Fantasy、Douyin 等。
   - 常见设计/AI 术语可按中文习惯处理，例如 `shallow depth of field` → `浅景深`，`photorealistic` → `照片级写实`，`cinematic lighting` → `电影感光影`。

4. **提示词翻译要保留可用性**
   - 把图片生成提示词当成“生成指令”翻译，不要逐字硬译。
   - 保留主体、数量、构图、镜头、光线、材质、色彩、比例、负面提示词、文字位置等约束。
   - 保留显式数量要求，例如 exactly 7、1、2、4x4 等，可译为“恰好 7 个 / 1 个 / 4x4”。
   - 保留模板占位符和参数结构，例如 `{argument name="hair color" default="dark brown"}` 默认不改，以免破坏模板系统。

5. **代码块处理**
   - 如果代码块是自然语言提示词，且主要为外文，则翻译代码块内容，但保留代码围栏。
   - 如果代码块是程序代码、JSON、YAML、Shell、SQL、HTML、CSS 等，默认不要翻译。
   - 如果代码块主要为中文，只夹杂少量英文，不翻译。

6. **输出**
   - 默认生成新文件副本，不覆盖原文件。
   - 输出文件名建议为：`原文件名.zh.md` 或 `原文件名.localized.zh-CN.md`。
   - 完成后简要说明处理范围、是否调用 API、是否有跳过项。

## 推荐自动化脚本

本 Skill 包含脚本：

```bash
python scripts/translate_markdown_to_zh.py INPUT.md -o OUTPUT.zh.md --concurrency 8 --model gpt-5.5
```

环境变量：

```bash
export OPENAI_API_KEY="你的 OpenAI API Key"
export OPENAI_MODEL="gpt-5.5"   # 可选，也可用 --model 指定
```

常用参数：

```bash
# 先查看会翻译多少块，不真正调用 API
python scripts/translate_markdown_to_zh.py docs/input.md --dry-run

# 并发翻译，保留缓存，适合大文件
python scripts/translate_markdown_to_zh.py docs/input.md -o docs/input.zh.md --concurrency 12 --cache .md_zh_cache.json

# 降低并发，避免触发速率限制
python scripts/translate_markdown_to_zh.py docs/input.md -o docs/input.zh.md --concurrency 3
```

## Agent 执行流程

1. 读取用户指定的 Markdown 文件。
2. 先判断是否需要自动脚本：
   - 单个小文件：agent 可以直接按本 Skill 规则翻译。
   - 大文件 / 多文件 / 用户要求加速：优先用脚本并发处理。
3. 运行前先不要覆盖原文件，输出到新路径。
4. 完成后检查：
   - URL 数量是否一致。
   - `assets/` 路径是否一致。
   - Markdown 代码围栏数量是否一致。
   - 主要中文大段是否未被误改。
5. 返回新文件下载链接或输出路径。

## API 说明

Skill 本身不是翻译 API。它是“规则 + 可执行脚本”。

- 如果由具备语言能力的 agent 手动执行，理论上不需要额外 API。
- 如果希望脚本无人值守、批量并发翻译，则需要配置模型 API。
- 默认脚本使用 OpenAI Responses API；也可以把 `call_openai()` 替换为 DeepL、Google Translate、Claude、Gemini 或内部翻译服务。
- 对图片生成提示词这类复杂文本，不建议只用传统机器翻译 API；建议用大语言模型，因为它更能保留提示词约束和自然中文表达。
