import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createTranslationRuntime,
  maskProtectedTokens,
  shouldTranslateChunk
} from '../scripts/translate-markdown.mjs';

test('中文主导段落应跳过翻译', () => {
  const input = '整体已经是中文，只夹杂 OpenAI、TikTok 和 prompt 这些英文词。';
  assert.equal(shouldTranslateChunk(input, { targetLanguage: 'zh-CN' }), false);
});

test('Markdown 链接文本可翻译，但链接目标必须保留', () => {
  const input = '[What does it do?](https://example.com/demo)';
  const { masked, tokens } = maskProtectedTokens(input, 1);
  assert.match(masked, /\[What does it do\?\]\(__PDF_MD_TOKEN_1_0__\)/);
  assert.equal(tokens[0].value, 'https://example.com/demo');
});

test('第二次运行应命中缓存，不再调用翻译器', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-cache-'));
  const cachePath = path.join(tempDir, 'cache.json');
  let callCount = 0;

  const runtime = createTranslationRuntime({
    translator: async (content) => {
      callCount += 1;
      return content.replace('Hello world', '你好，世界');
    }
  });

  try {
    const first = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      maxChars: 12000,
      concurrency: 1,
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    const second = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      maxChars: 12000,
      concurrency: 1,
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    assert.equal(first.content, '你好，世界');
    assert.equal(second.content, '你好，世界');
    assert.equal(callCount, 1);
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(Object.keys(cache).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('无语言 fenced prompt block 应保留围栏，后续图片表格不能被吞进代码块', async () => {
  const markdown = [
    '### Case 144: Demo',
    '| 输出效果 |',
    '| :----: |',
    '| <a href="https://example.com"><img src="assets/demo.jpg" width="300" alt="输出图像"></a> |',
    '',
    '**提示词：**',
    '',
    '```',
    'A dramatic luxury product advertising image.',
    '```',
    '',
    '### Case 145: Demo 2',
    '| 输出效果 |',
    '| :----: |',
    '| <a href="https://example.com"><img src="assets/demo-2.jpg" width="300" alt="输出图像"></a> |',
    '',
    '**提示词：**',
    '',
    '```',
    'Another prompt body.',
    '```'
  ].join('\n');

  const runtime = createTranslationRuntime({
    translator: async (content) => content
      .replace(/```/g, '')
      .replace('A dramatic luxury product advertising image.', '一张戏剧化的奢华产品广告图像。')
      .replace('Another prompt body.', '另一段提示词内容。')
  });

  const result = await runtime.translateMarkdown(markdown, {
    targetLanguage: 'zh-CN',
    maxChars: 12000,
    concurrency: 1,
    model: 'deepseek-chat'
  });

  assert.equal((result.content.match(/^```$/gm) || []).length, 4);
  assert.match(result.content, /```[\r\n]+一张戏剧化的奢华产品广告图像。[\r\n]+```/);
  assert.match(result.content, /```[\r\n]+另一段提示词内容。[\r\n]+```/);

  let inCodeFence = false;
  const case145State = result.content.split(/\r?\n/).find((line) => {
    if (line.trim() === '```') {
      inCodeFence = !inCodeFence;
    }
    return line.includes('### Case 145');
  });

  assert.equal(case145State, '### Case 145: Demo 2');
  assert.equal(inCodeFence, false);
});

test('模型给 fenced prompt block 额外包上 ```json 时应自动剥离', async () => {
  const markdown = [
    '### Case 1: Demo',
    '',
    '**提示词：**',
    '',
    '```',
    '{',
    '  "type": "brand identity and merchandise design board"',
    '}',
    '```',
    '',
    '### Case 2: Next'
  ].join('\n');

  const runtime = createTranslationRuntime({
    translator: async (content) => {
      if (!content.includes('brand identity and merchandise design board')) {
        return content;
      }

      return [
        '```json',
        '{',
        '  "type": "品牌标识和商品设计板"',
        '}',
        '```'
      ].join('\n');
    }
  });

  const result = await runtime.translateMarkdown(markdown, {
    targetLanguage: 'zh-CN',
    model: 'deepseek-chat',
    concurrency: 1
  });

  assert.doesNotMatch(result.content, /^```json$/m);
  assert.match(result.content, /"type": "品牌标识和商品设计板"/);
  assert.match(result.content, /\*\*提示词：\*\*/);
  assert.match(result.content, /### Case 2: Next/);
});

test('默认使用小块高并发调度', async () => {
  const markdown = [
    'First paragraph about a dramatic product shot.',
    '',
    'Second paragraph about bold cinematic lighting.'
  ].join('\n');

  const runtime = createTranslationRuntime({
    translator: async (content) => content
      .replace('First paragraph about a dramatic product shot.', '第一段关于戏剧化产品镜头的描述。')
      .replace('Second paragraph about bold cinematic lighting.', '第二段关于大胆电影感光影的描述。')
  });

  const result = await runtime.translateMarkdown(markdown, {
    targetLanguage: 'zh-CN',
    model: 'deepseek-chat'
  });

  assert.equal(result.translatedChunkCount, 2);
  assert.equal(result.concurrency, 12);
  assert.match(result.content, /第一段关于戏剧化产品镜头的描述。/);
  assert.match(result.content, /第二段关于大胆电影感光影的描述。/);
});

test('明显未翻译的结果不会写入缓存', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-cache-quality-'));
  const cachePath = path.join(tempDir, 'cache.json');
  let callCount = 0;

  const runtime = createTranslationRuntime({
    translator: async (content) => {
      callCount += 1;
      return callCount === 1 ? content : content.replace('Hello world', '你好，世界');
    }
  });

  try {
    const first = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    const second = await runtime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    assert.equal(first.content, 'Hello world');
    assert.equal(second.content, '你好，世界');
    assert.equal(callCount, 2);

    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(Object.keys(cache).length, 1);
    assert.equal(Object.values(cache)[0], '你好，世界');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('坏缓存命中时会跳过并重新翻译', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-cache-refresh-'));
  const cachePath = path.join(tempDir, 'cache.json');

  const seedRuntime = createTranslationRuntime({
    translator: async (content) => content.replace('Hello world', '你好，世界')
  });

  let refreshCallCount = 0;
  const refreshRuntime = createTranslationRuntime({
    translator: async (content) => {
      refreshCallCount += 1;
      return content.replace('Hello world', '你好，世界（重翻）');
    }
  });

  try {
    await seedRuntime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    const [cacheKey] = Object.keys(cache);
    cache[cacheKey] = 'Hello world';
    await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');

    const result = await refreshRuntime.translateMarkdown('Hello world', {
      targetLanguage: 'zh-CN',
      cacheFile: cachePath,
      model: 'deepseek-chat'
    });

    assert.equal(result.content, '你好，世界（重翻）');
    assert.equal(result.cacheHitCount, 0);
    assert.equal(refreshCallCount, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
