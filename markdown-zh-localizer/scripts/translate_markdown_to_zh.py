#!/usr/bin/env python3
"""
Translate non-Chinese human-readable content in Markdown to Simplified Chinese.

Features:
- Preserves Markdown structure, fenced code blocks, HTML tags, URLs, asset paths, and placeholders.
- Skips Chinese-majority blocks with only small foreign-language fragments.
- Translates natural-language prompt code blocks when they are mainly non-Chinese.
- Concurrent API calls with retry and cache.
- Uses OpenAI Responses API by default via stdlib urllib, no external Python dependency.

Usage:
    export OPENAI_API_KEY="..."
    python scripts/translate_markdown_to_zh.py input.md -o input.zh.md --concurrency 8 --model gpt-5.5

Dry run:
    python scripts/translate_markdown_to_zh.py input.md --dry-run
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple


SYSTEM_PROMPT = """你是专业的 Markdown 中文本地化翻译器。

任务：把输入片段中“主要为非中文的自然语言内容”翻译成简体中文。

必须遵守：
1. 保留 Markdown 结构、标题符号、列表符号、表格符号、引用符号、代码围栏、空行。
2. 不翻译、不改写任何形如 ⟦KEEP_0000⟧ 的占位符。
3. 不翻译链接、资源路径、HTML 标签、代码变量、模板占位符。
4. 如果一整块主要是中文，只夹杂少量英文/日文/韩文/品牌名/平台名/参数词，则原样返回，不要翻译。
5. 专有名词优先保留，例如 TikTok、OpenAI、GPT Image、Minecraft、Final Fantasy、Apple Park 等。
6. 图片生成提示词要按中文提示词习惯翻译，保留主体、数量、构图、镜头、光线、材质、色彩、比例、负面提示词等约束，不要删减。
7. 不要添加解释、不要总结，只返回翻译后的原片段。
"""

PROTECT_PATTERNS = [
    # Fenced placeholders / template arguments, e.g. {argument name="hair color" default="dark brown"}
    re.compile(r"\{argument\b[^{}]*\}"),
    # URLs
    re.compile(r"https?://[^\s<>)\"']+"),
    re.compile(r"www\.[^\s<>)\"']+"),
    # Markdown link or image destination: ](assets/x.jpg), ](https://...)
    re.compile(r"(?<=\]\()[^)]+(?=\))"),
    # HTML tags
    re.compile(r"</?[\w:-]+(?:\s+[^<>]*)?>"),
    # Common local asset paths
    re.compile(r"(?<![\w/.-])(?:\.{0,2}/)?(?:assets|images|img|docs|public|static|src)/[^\s<>)\"']+"),
    # Inline code
    re.compile(r"`[^`\n]+`"),
]

PROGRAMMING_LANGS = {
    "python", "py", "javascript", "js", "typescript", "ts", "tsx", "jsx",
    "json", "yaml", "yml", "toml", "xml", "html", "css", "scss",
    "bash", "sh", "zsh", "powershell", "ps1", "sql", "go", "rust",
    "java", "c", "cpp", "csharp", "php", "ruby", "swift", "kotlin",
    "dockerfile", "makefile"
}

CODE_LIKE_RE = re.compile(
    r"(\bfunction\b|\bclass\b|\bconst\b|\blet\b|\bvar\b|\bimport\b|\bfrom\b|\bdef\b|"
    r"^\s*[{[\]}]\s*$|;\s*$|=>|</\w+>|<\w+\s+|SELECT\s+.+\s+FROM|"
    r"\bconsole\.log\b|\breturn\b|^\s*#include\b)",
    re.IGNORECASE | re.MULTILINE,
)

FENCE_RE = re.compile(r"(```|~~~)([^\n]*)\n([\s\S]*?)\n\1", re.MULTILINE)


@dataclass
class Segment:
    index: int
    text: str
    kind: str  # "plain", "fence", "skip"
    should_translate: bool


def count_chars(text: str) -> Tuple[int, int, int]:
    """Return chinese_count, foreign_letter_count, total_visible_alnum_cjk."""
    chinese = 0
    foreign = 0
    total = 0
    for ch in text:
        code = ord(ch)
        is_cjk = (
            0x4E00 <= code <= 0x9FFF or
            0x3400 <= code <= 0x4DBF or
            0x3040 <= code <= 0x30FF or  # Japanese kana
            0xAC00 <= code <= 0xD7AF     # Hangul
        )
        if "\u4e00" <= ch <= "\u9fff":
            chinese += 1
            total += 1
        elif is_cjk:
            foreign += 1
            total += 1
        elif ch.isalpha():
            # Latin/Cyrillic/etc.
            foreign += 1
            total += 1
        elif ch.isdigit():
            total += 1
    return chinese, foreign, total


def strip_protected_like_text(text: str) -> str:
    text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    text = re.sub(r"</?[\w:-]+(?:\s+[^<>]*)?>", " ", text)
    text = re.sub(r"`[^`\n]+`", " ", text)
    text = re.sub(r"\{argument\b[^{}]*\}", " ", text)
    text = re.sub(r"(?<=\]\()[^)]+(?=\))", " ", text)
    return text


def is_chinese_majority(text: str) -> bool:
    visible = strip_protected_like_text(text)
    chinese, foreign, total = count_chars(visible)
    if total == 0:
        return True
    # If it has a strong Chinese core and foreign text is minor, leave unchanged.
    return chinese >= 12 and chinese / max(total, 1) >= 0.55


def has_enough_foreign_text(text: str) -> bool:
    visible = strip_protected_like_text(text)
    chinese, foreign, total = count_chars(visible)
    if total < 4:
        return False
    if is_chinese_majority(text):
        return False
    return foreign >= 8 or (foreign >= 4 and chinese == 0)


def is_probably_program_code(content: str, lang: str = "") -> bool:
    lang = (lang or "").strip().lower().split()[0] if lang else ""
    if lang in PROGRAMMING_LANGS:
        return True
    if CODE_LIKE_RE.search(content):
        # Natural-language prompt blocks can have punctuation but usually not code tokens.
        chinese, foreign, total = count_chars(strip_protected_like_text(content))
        if foreign < 80:
            return True
    return False


def protect(text: str) -> Tuple[str, Dict[str, str]]:
    mapping: Dict[str, str] = {}

    def add(match: re.Match) -> str:
        key = f"⟦KEEP_{len(mapping):04d}⟧"
        mapping[key] = match.group(0)
        return key

    # Apply patterns sequentially. Existing KEEP tokens are not matched by these patterns.
    protected = text
    for pattern in PROTECT_PATTERNS:
        protected = pattern.sub(add, protected)
    return protected, mapping


def unprotect(text: str, mapping: Dict[str, str]) -> str:
    for key, value in mapping.items():
        text = text.replace(key, value)
    return text


def split_plain_into_blocks(text: str) -> List[str]:
    """Split plain Markdown text into translatable units while preserving whitespace."""
    if not text:
        return []
    # Split on blank-line groups but keep delimiters.
    parts = re.split(r"(\n\s*\n)", text)
    blocks: List[str] = []
    buf = ""
    for part in parts:
        if re.match(r"\n\s*\n\Z", part or ""):
            if buf:
                blocks.append(buf)
                buf = ""
            blocks.append(part)
        else:
            # Split very long sections by line groups to avoid huge prompts.
            if len(part) > 6000:
                lines = part.splitlines(keepends=True)
                chunk = ""
                for line in lines:
                    if len(chunk) + len(line) > 3500 and chunk:
                        blocks.append(chunk)
                        chunk = ""
                    chunk += line
                if chunk:
                    blocks.append(chunk)
            else:
                buf += part
    if buf:
        blocks.append(buf)
    return blocks


def segment_markdown(markdown: str) -> List[Segment]:
    segments: List[Segment] = []
    cursor = 0
    idx = 0

    for m in FENCE_RE.finditer(markdown):
        if m.start() > cursor:
            plain = markdown[cursor:m.start()]
            for block in split_plain_into_blocks(plain):
                should = has_enough_foreign_text(block)
                segments.append(Segment(idx, block, "plain", should))
                idx += 1

        fence_text = m.group(0)
        fence_marker, lang, content = m.group(1), m.group(2), m.group(3)
        should = has_enough_foreign_text(content) and not is_probably_program_code(content, lang)
        segments.append(Segment(idx, fence_text, "fence", should))
        idx += 1
        cursor = m.end()

    if cursor < len(markdown):
        plain = markdown[cursor:]
        for block in split_plain_into_blocks(plain):
            should = has_enough_foreign_text(block)
            segments.append(Segment(idx, block, "plain", should))
            idx += 1

    return segments


def extract_output_text(data: dict) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    texts: List[str] = []
    for item in data.get("output", []) or []:
        for content in item.get("content", []) or []:
            if isinstance(content, dict):
                if content.get("type") in {"output_text", "text"} and isinstance(content.get("text"), str):
                    texts.append(content["text"])
                elif isinstance(content.get("text"), dict) and isinstance(content["text"].get("value"), str):
                    texts.append(content["text"]["value"])
    if texts:
        return "".join(texts)
    raise RuntimeError(f"Cannot extract output text from API response: {json.dumps(data)[:500]}")


def call_openai(text: str, model: str, timeout: int = 120) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for API translation. Use --dry-run to inspect without API calls.")

    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    url = f"{base_url}/responses"

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return extract_output_text(data)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI API HTTP {e.code}: {detail}") from e


def translate_segment(seg: Segment, model: str, retries: int = 4) -> str:
    if not seg.should_translate:
        return seg.text

    original = seg.text
    protected, mapping = protect(original)

    for attempt in range(retries + 1):
        try:
            translated = call_openai(protected, model=model)
            translated = unprotect(translated, mapping)
            return translated
        except Exception:
            if attempt >= retries:
                raise
            sleep_s = min(30, (2 ** attempt) + random.random())
            time.sleep(sleep_s)

    return original


def load_cache(path: Path | None) -> Dict[str, str]:
    if path and path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_cache(path: Path | None, cache: Dict[str, str]) -> None:
    if not path:
        return
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate_preservation(src: str, dst: str) -> List[str]:
    warnings: List[str] = []

    def urls(s: str) -> List[str]:
        return sorted(re.findall(r"https?://[^\s<>)\"']+", s))

    def assets(s: str) -> List[str]:
        return sorted(re.findall(r"(?<![\w/.-])(?:\.{0,2}/)?(?:assets|images|img|docs|public|static|src)/[^\s<>)\"']+", s))

    if urls(src) != urls(dst):
        warnings.append("URL 列表与原文不完全一致，请人工检查。")
    if assets(src) != assets(dst):
        warnings.append("资源路径列表与原文不完全一致，请人工检查。")
    if src.count("```") != dst.count("```"):
        warnings.append("``` 代码围栏数量发生变化，请人工检查。")
    if src.count("~~~") != dst.count("~~~"):
        warnings.append("~~~ 代码围栏数量发生变化，请人工检查。")
    return warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Translate non-Chinese Markdown content to Simplified Chinese.")
    parser.add_argument("input", help="Input Markdown file")
    parser.add_argument("-o", "--output", help="Output Markdown file. Default: <input>.zh.md")
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "gpt-5.5"), help="OpenAI model name")
    parser.add_argument("--concurrency", type=int, default=6, help="Concurrent API calls")
    parser.add_argument("--cache", default=".md_zh_localizer_cache.json", help="Cache JSON path; use empty string to disable")
    parser.add_argument("--dry-run", action="store_true", help="Only inspect segments; do not call API")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 2

    output_path = Path(args.output) if args.output else input_path.with_name(input_path.stem + ".zh" + input_path.suffix)
    markdown = input_path.read_text(encoding="utf-8")
    segments = segment_markdown(markdown)
    todo = [s for s in segments if s.should_translate]

    print(f"Segments: {len(segments)} total, {len(todo)} translatable, {len(segments) - len(todo)} skipped.")
    if args.dry_run:
        for s in todo[:20]:
            preview = s.text.strip().replace("\n", " ")[:160]
            print(f"- #{s.index} [{s.kind}] {preview}")
        if len(todo) > 20:
            print(f"... {len(todo) - 20} more")
        return 0

    cache_path = Path(args.cache) if args.cache else None
    cache = load_cache(cache_path)

    results: Dict[int, str] = {s.index: s.text for s in segments}
    to_run: List[Segment] = []
    for s in segments:
        if not s.should_translate:
            continue
        key = sha(s.text)
        if key in cache:
            results[s.index] = cache[key]
        else:
            to_run.append(s)

    print(f"API calls needed: {len(to_run)}; cached: {len(todo) - len(to_run)}; concurrency: {args.concurrency}")

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as ex:
        future_map = {ex.submit(translate_segment, s, args.model): s for s in to_run}
        for fut in concurrent.futures.as_completed(future_map):
            seg = future_map[fut]
            translated = fut.result()
            results[seg.index] = translated
            cache[sha(seg.text)] = translated
            completed += 1
            if completed % 5 == 0 or completed == len(to_run):
                save_cache(cache_path, cache)
                print(f"Completed {completed}/{len(to_run)}")

    save_cache(cache_path, cache)

    output = "".join(results[i] for i in range(len(segments)))
    warnings = validate_preservation(markdown, output)
    output_path.write_text(output, encoding="utf-8")

    print(f"Written: {output_path}")
    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
