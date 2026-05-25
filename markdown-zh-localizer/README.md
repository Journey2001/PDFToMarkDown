# markdown-zh-localizer

一个用于 Markdown 文档中文本地化的 Agent Skill。

它适合处理 README、文档、图片生成提示词合集、案例库等文件：只翻译主要为外文的自然语言内容，保留 Markdown 结构、链接、图片路径、HTML 标签、代码围栏和中文大段内容。

## 是否需要翻译 API？

分两种情况：

1. **Skill 说明型使用**：不一定需要 API。  
   其他 agent 读 `SKILL.md` 后，可以用自身语言能力按规则翻译。

2. **脚本批量并发使用**：需要 API。  
   `scripts/translate_markdown_to_zh.py` 默认调用 OpenAI Responses API，需要设置 `OPENAI_API_KEY`。

## 快速开始

```bash
export OPENAI_API_KEY="你的 OpenAI API Key"

python scripts/translate_markdown_to_zh.py ./input.md \
  -o ./input.zh.md \
  --model gpt-5.5 \
  --concurrency 8
```

先预览：

```bash
python scripts/translate_markdown_to_zh.py ./input.md --dry-run
```

## 并发建议

- 小文件：`--concurrency 3`
- 中等 Markdown 文件：`--concurrency 6` 到 `8`
- 大批量文件：`--concurrency 8` 到 `16`，并配合 cache
- 如果遇到 rate limit，降低并发或换 Batch API/队列模式

## 目录

```text
markdown-zh-localizer/
├── SKILL.md
├── README.md
├── scripts/
│   └── translate_markdown_to_zh.py
└── examples/
    └── sample.md
```

## 可替换 API

脚本中 `call_openai()` 是唯一的模型调用函数。你可以把它替换成：

- DeepL
- Google Translate
- Gemini
- Claude
- 内部翻译服务
- 本地大模型网关

但对于图片生成提示词类内容，推荐使用大语言模型而不是传统翻译 API，因为需要保留提示词约束、数量、构图、风格和自然中文表达。
