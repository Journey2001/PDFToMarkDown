import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { createTranslationRuntime } from '../../scripts/translate-markdown.mjs';

const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const DEFAULT_CACHE_FILE_NAME = '.translation-cache.json';

function buildOutputPath(inputPath, targetLanguage) {
  const extension = path.extname(inputPath);
  const baseName = path.basename(inputPath, extension);
  return path.join(path.dirname(inputPath), `${baseName}.translated.${targetLanguage}${extension}`);
}

function resolveCacheFilePath(inputPath, explicitCacheFile) {
  if (typeof explicitCacheFile === 'string') {
    const trimmed = explicitCacheFile.trim();
    if (!trimmed) {
      return null;
    }

    return path.resolve(trimmed);
  }

  return path.join(path.dirname(inputPath), DEFAULT_CACHE_FILE_NAME);
}

export function createTranslateService(options = {}) {
  const runtime = options.runtime ?? createTranslationRuntime();

  return {
    async run(input = {}) {
      const targetLanguage = input.targetLanguage || DEFAULT_TARGET_LANGUAGE;
      const outputPath = path.resolve(input.outputPath || buildOutputPath(input.markdownPath, targetLanguage));
      const cacheFile = resolveCacheFilePath(input.markdownPath, input.cacheFile);
      const originalMarkdown = await readFile(input.markdownPath, 'utf8');
      const startedAt = Date.now();
      const translated = await runtime.translateMarkdown(originalMarkdown, {
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        batchSize: input.batchSize,
        cacheFile,
        concurrency: input.concurrency,
        inputPath: input.markdownPath,
        maxChars: input.maxChars,
        model: input.model,
        progress: input.progress,
        targetLanguage
      });

      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, translated.content, 'utf8');

      return {
        inputPath: input.markdownPath,
        outputPath,
        targetLanguage,
        model: input.model ?? 'deepseek-chat',
        translatedChunkCount: translated.translatedChunkCount,
        skippedChunkCount: translated.skippedChunkCount,
        totalEntryCount: translated.totalEntryCount,
        translatedEntryCount: translated.translatedEntryCount,
        cacheHitCount: translated.cacheHitCount,
        concurrency: translated.concurrency,
        retryCount: translated.retryCount,
        cacheFile: translated.cacheFile,
        elapsedMs: Date.now() - startedAt
      };
    }
  };
}
