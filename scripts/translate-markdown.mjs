import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROGRESS_PREFIX = '__TRANSLATE_PROGRESS__';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
const DEFAULT_BASE_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_CACHE_FILE_NAME = '.translation-cache.json';
const CACHE_KEY_VERSION = 'v2';
const MAX_RETRY_COUNT = 2;
const RETRY_BASE_DELAY_MS = 800;
const SEGMENT_DELIMITER_PREFIX = '[[[PDFTOMARKDOWN_SEGMENT_';
const PASSTHROUGH_FENCE_LANGUAGES = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'powershell',
  'ps1',
  'cmd',
  'bat',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'html',
  'css',
  'sql',
  'python',
  'py'
]);

function parseArgs(argv) {
  const options = {
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL,
    json: false,
    maxChars: DEFAULT_MAX_CHARS,
    concurrency: DEFAULT_CONCURRENCY,
    batchSize: DEFAULT_BATCH_SIZE
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--input') {
      options.inputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--output') {
      options.outputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--target-lang') {
      options.targetLanguage = argv[index + 1] || DEFAULT_TARGET_LANGUAGE;
      index += 1;
      continue;
    }

    if (arg === '--api-key') {
      options.apiKey = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--model') {
      options.model = argv[index + 1] || DEFAULT_MODEL;
      index += 1;
      continue;
    }

    if (arg === '--base-url') {
      options.baseUrl = argv[index + 1] || DEFAULT_BASE_URL;
      index += 1;
      continue;
    }

    if (arg === '--max-chars') {
      options.maxChars = Number(argv[index + 1]) || DEFAULT_MAX_CHARS;
      index += 1;
      continue;
    }

    if (arg === '--concurrency') {
      options.concurrency = Number(argv[index + 1]) || DEFAULT_CONCURRENCY;
      index += 1;
      continue;
    }

    if (arg === '--batch-size') {
      options.batchSize = Number(argv[index + 1]) || DEFAULT_BATCH_SIZE;
      index += 1;
      continue;
    }

    if (arg === '--cache-file') {
      options.cacheFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--progress') {
      options.progress = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log([
    'Translate a local Markdown file with DeepSeek and save it as a sibling file.',
    '',
    'Usage:',
    '  node scripts/translate-markdown.mjs --input <file.md> [options]',
    '',
    'Options:',
    '  --input        Local markdown file to translate',
    '  --output       Optional output markdown path',
    '  --target-lang  Target language code (default: zh-CN)',
    '  --api-key      DeepSeek API key (or use DEEPSEEK_API_KEY)',
    '  --model        Chat model name (default: deepseek-chat)',
    '  --base-url     Chat completions URL',
    '  --max-chars    Chunk size hint for each API request',
    '  --concurrency  Number of concurrent translation workers',
    '  --batch-size   Number of chunk entries per API request',
    '  --cache-file   Optional JSON cache file path',
    '  --json         Print machine-readable JSON result',
    '  --help, -h     Show this help message'
  ].join('\n'));
}

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

function normalizeOptions(options = {}) {
  return {
    ...options,
    targetLanguage: options.targetLanguage || DEFAULT_TARGET_LANGUAGE,
    model: options.model || DEFAULT_MODEL,
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    maxChars: Number(options.maxChars) > 0 ? Number(options.maxChars) : DEFAULT_MAX_CHARS,
    concurrency: Number(options.concurrency) > 0 ? Number(options.concurrency) : DEFAULT_CONCURRENCY,
    batchSize: Number(options.batchSize) > 0 ? Number(options.batchSize) : DEFAULT_BATCH_SIZE,
    cacheFile: options.cacheFile ?? null
  };
}

function splitMarkdownIntoSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let buffer = [];
  let inCodeFence = false;
  let currentFenceType = 'translate';
  let fenceOpeningLine = '';

  const flush = (type, extra = {}) => {
    if (buffer.length === 0) {
      return;
    }

    sections.push({
      type,
      content: buffer.join('\n'),
      ...extra
    });
    buffer = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (/^```/.test(trimmedLine)) {
      if (inCodeFence) {
        if (currentFenceType === 'passthrough') {
          buffer.push(line);
          flush('passthrough');
        } else {
          flush('translatable-fence', {
            openingFence: fenceOpeningLine,
            closingFence: line
          });
        }
        inCodeFence = false;
        currentFenceType = 'translate';
        fenceOpeningLine = '';
      } else {
        const passthroughFence = shouldPassthroughFence(trimmedLine);
        flush('translate');

        if (passthroughFence) {
          currentFenceType = 'passthrough';
          buffer.push(line);
        } else {
          currentFenceType = 'translatable-fence';
          fenceOpeningLine = line;
        }

        inCodeFence = true;
      }
      continue;
    }

    buffer.push(line);
  }

  if (inCodeFence) {
    if (currentFenceType === 'passthrough') {
      flush('passthrough');
    } else {
      flush('translatable-fence', {
        openingFence: fenceOpeningLine,
        closingFence: ''
      });
    }
  } else {
    flush('translate');
  }

  return sections;
}

function shouldPassthroughFence(openingFenceLine) {
  const match = openingFenceLine.match(/^```\s*([^\s]+)?/);
  const language = (match?.[1] || '').toLowerCase();
  if (!language) {
    return false;
  }

  return PASSTHROUGH_FENCE_LANGUAGES.has(language);
}

function splitTranslatableSection(content, maxChars) {
  const normalized = content.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      chunks.push(paragraph);
      continue;
    }

    const lines = paragraph.split('\n');
    let lineBuffer = '';

    for (const line of lines) {
      const lineCandidate = lineBuffer ? `${lineBuffer}\n${line}` : line;
      if (lineCandidate.length <= maxChars) {
        lineBuffer = lineCandidate;
      } else {
        if (lineBuffer) {
          chunks.push(lineBuffer);
        }
        lineBuffer = line;
      }
    }

    if (lineBuffer) {
      chunks.push(lineBuffer);
    }
  }

  return chunks;
}

function splitFencedContent(content, maxChars) {
  if (!content) {
    return [];
  }

  const lines = content.split('\n');
  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (!buffer) {
      return;
    }

    chunks.push(buffer);
    buffer = '';
  };

  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    flush();
    buffer = line;
  }

  flush();
  return chunks;
}

function stripProtectedLikeText(content) {
  return content
    .replace(/\{argument\b[^{}]*\}/g, ' ')
    .replace(/https?:\/\/[^\s)"'>]+/g, ' ')
    .replace(/www\.[^\s)"'>]+/g, ' ')
    .replace(/(?<=\]\()[^)]+(?=\))/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`[^`\n]+`/g, ' ');
}

function collectTextStats(content) {
  const visible = stripProtectedLikeText(content);
  let chinese = 0;
  let foreign = 0;
  let total = 0;
  const foreignWordCount = (visible.match(/[A-Za-z][A-Za-z0-9_-]*/g) || []).length;

  for (const char of visible) {
    const code = char.codePointAt(0) || 0;
    const isChinese = code >= 0x4e00 && code <= 0x9fff;
    const isCjkForeign = (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af);

    if (isChinese) {
      chinese += 1;
      total += 1;
      continue;
    }

    if (isCjkForeign || /\p{Letter}/u.test(char)) {
      foreign += 1;
      total += 1;
      continue;
    }

    if (/\p{Number}/u.test(char)) {
      total += 1;
    }
  }

  return { chinese, foreign, total, foreignWordCount };
}

function isChineseMajorityChunk(content) {
  const { chinese, foreign, total, foreignWordCount } = collectTextStats(content);
  if (total === 0) {
    return true;
  }

  return chinese >= 12 && chinese / total >= 0.35 && foreignWordCount <= 6 && chinese >= foreignWordCount * 2;
}

function hasEnoughForeignText(content) {
  const { chinese, foreign, total } = collectTextStats(content);
  if (total < 4) {
    return false;
  }

  if (isChineseMajorityChunk(content)) {
    return false;
  }

  return foreign >= 8 || (foreign >= 4 && chinese === 0);
}

export function shouldTranslateChunk(chunk, options = {}) {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return false;
  }

  if ((options.targetLanguage || DEFAULT_TARGET_LANGUAGE) !== 'zh-CN') {
    return true;
  }

  return hasEnoughForeignText(trimmed);
}

function buildChunkEntries(sections, options) {
  const entries = [];
  let entryId = 0;

  sections.forEach((section, sectionIndex) => {
    if (section.type === 'passthrough' || !section.content.trim()) {
      return;
    }

    const chunks = section.type === 'translatable-fence'
      ? splitFencedContent(section.content, options.maxChars)
      : splitTranslatableSection(section.content, options.maxChars);

    chunks.forEach((chunk, chunkIndex) => {
      entries.push({
        id: entryId,
        sectionIndex,
        chunkIndex,
        original: chunk,
        shouldTranslate: shouldTranslateChunk(chunk, options)
      });
      entryId += 1;
    });
  });

  return entries;
}

function buildWorkItems(entries, options) {
  const workItems = [];
  let currentEntries = [];
  let currentLength = 0;
  const maxBatchEntries = Number(options.batchSize) > 0 ? Number(options.batchSize) : DEFAULT_BATCH_SIZE;

  const flush = () => {
    if (currentEntries.length === 0) {
      return;
    }

    workItems.push({
      entries: currentEntries
    });
    currentEntries = [];
    currentLength = 0;
  };

  for (const entry of entries) {
    const delimiterLength = currentEntries.length === 0 ? 0 : 32;
    const candidateLength = currentLength + delimiterLength + entry.original.length;
    if (
      currentEntries.length > 0
      && (candidateLength > options.maxChars || currentEntries.length >= maxBatchEntries)
    ) {
      flush();
    }

    currentEntries.push(entry);
    currentLength += (currentEntries.length === 1 ? 0 : 32) + entry.original.length;
  }

  flush();
  return workItems;
}

function buildProtectedToken(segmentId, tokenIndex) {
  return `__PDF_MD_TOKEN_${segmentId}_${tokenIndex}__`;
}

export function maskProtectedTokens(content, segmentId) {
  const tokens = [];
  let masked = content;

  const protect = (regex, replacer = (match) => match) => {
    masked = masked.replace(regex, (...args) => {
      const match = args[0];
      const replacementValue = replacer(match, ...args.slice(1, -2));
      const token = buildProtectedToken(segmentId, tokens.length);
      tokens.push({ token, value: replacementValue });
      return replacementValue === match ? token : replacementValue.replace(replacementValue, token);
    });
  };

  protect(/\{argument\b[^{}]*\}/g);
  protect(/(?<=\]\()[^)]+(?=\))/g);
  protect(/<[^>]+>/g);
  protect(/`[^`\n]+`/g);
  protect(/https?:\/\/[^\s)"'>]+/g);
  protect(/www\.[^\s)"'>]+/g);

  return { masked, tokens };
}

function unmaskProtectedTokens(content, tokens) {
  let output = content;

  tokens.forEach(({ token, value }) => {
    output = output.split(token).join(value);
  });

  if (/__PDF_MD_TOKEN_\d+_\d+__/.test(output)) {
    throw new Error('Protected tokens remain after unmasking');
  }

  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emitProgress(options, payload) {
  if (!options.progress) {
    return;
  }

  process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify(payload)}\n`);
}

function buildSegmentDelimiter(index) {
  return `${SEGMENT_DELIMITER_PREFIX}${index}]]]`;
}

function splitTranslatedSegments(content, expectedCount) {
  if (expectedCount === 1) {
    return [content.trim()];
  }

  const delimiters = Array.from({ length: expectedCount - 1 }, (_, index) => buildSegmentDelimiter(index));
  const separatorPattern = delimiters.map((delimiter) => escapeRegExp(delimiter)).join('|');
  const parts = content
    .split(new RegExp(`\\s*(?:${separatorPattern})\\s*`, 'g'))
    .map((part) => part.trim());

  return parts.length === expectedCount ? parts : null;
}

function stripAccidentalOuterFence(content) {
  let output = content;

  while (true) {
    const trimmed = output.trim();
    if (!trimmed.startsWith('```')) {
      return output;
    }

    const lines = trimmed.split('\n');
    if (lines.length < 3 || !/^```/.test(lines[0].trim()) || lines.at(-1)?.trim() !== '```') {
      return output;
    }

    output = lines.slice(1, -1).join('\n');
  }
}

function buildBatchPayload(entries) {
  const maskedSegments = entries.map((entry) => {
    const { masked, tokens } = maskProtectedTokens(entry.original, entry.id);
    return {
      id: entry.id,
      masked,
      tokens
    };
  });

  const content = maskedSegments
    .map((segment, index) => {
      if (index === 0) {
        return segment.masked;
      }

      return `${buildSegmentDelimiter(index - 1)}\n\n${segment.masked}`;
    })
    .join('\n\n');

  return {
    content,
    maskedSegments
  };
}

function buildSystemPrompt(options, segmentCount) {
  const promptParts = [
    `Translate user-provided Markdown into ${options.targetLanguage}.`,
    'Preserve Markdown structure, list indentation, tables, spacing, and fenced code markers.',
    'Keep programming or command code fences unchanged.',
    'For prompt-like, marketing, or visual-description text, localize into natural Simplified Chinese instead of stiff literal translation.',
    'Preserve constraints such as counts, composition, camera angle, lighting, materials, color, layout, and negative prompts.',
    'Keep brand names, product names, placeholders, URLs, file paths, HTML tags, and code identifiers unchanged.',
    'If a block is already Chinese-majority, keep it unchanged.',
    'Return only translated Markdown with no explanation.'
  ];

  if (segmentCount > 1) {
    promptParts.push('The input contains multiple segments separated by explicit segment delimiters.');
    promptParts.push('Keep every delimiter token exactly unchanged and in the same order.');
    promptParts.push('Do not add, remove, rename, or translate any segment delimiter token.');
  }

  return promptParts.join(' ');
}

function normalizeComparableText(value) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]+/gu, '');
}

function isObviouslyUntranslatedResult(original, translated, options) {
  if ((options.targetLanguage || DEFAULT_TARGET_LANGUAGE) !== 'zh-CN') {
    return false;
  }

  const originalTrimmed = original.trim();
  const translatedTrimmed = translated.trim();
  if (!originalTrimmed || !translatedTrimmed) {
    return false;
  }

  if (normalizeComparableText(originalTrimmed) === normalizeComparableText(translatedTrimmed)) {
    return true;
  }

  if (!shouldTranslateChunk(originalTrimmed, options)) {
    return false;
  }

  const originalStats = collectTextStats(originalTrimmed);
  const translatedStats = collectTextStats(translatedTrimmed);

  return shouldTranslateChunk(translatedTrimmed, options)
    && translatedStats.chinese <= originalStats.chinese + 4
    && translatedStats.foreign >= Math.max(8, Math.floor(originalStats.foreign * 0.7));
}

function isReusableTranslation(entry, translated, options) {
  return !isObviouslyUntranslatedResult(entry.original, translated, options);
}

async function requestTranslation(content, options, segmentCount) {
  const response = await fetch(options.baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(options, segmentCount)
        },
        {
          role: 'user',
          content
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const translated = data.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error('DeepSeek API returned an empty translation result');
  }

  return translated;
}

async function translateWorkItem(workItem, options, translator) {
  const { content, maskedSegments } = buildBatchPayload(workItem.entries);
  const translated = await translator(content, options, maskedSegments.length);
  const translatedParts = splitTranslatedSegments(translated, maskedSegments.length);

  if (!translatedParts) {
    throw new Error('Translated response does not preserve segment delimiters');
  }

  return maskedSegments.map((segment, index) => ({
    id: segment.id,
    content: unmaskProtectedTokens(translatedParts[index], segment.tokens)
  }));
}

async function translateWorkItemWithRetry(workItem, options, translator) {
  for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt += 1) {
    try {
      return await translateWorkItem(workItem, options, translator);
    } catch (error) {
      if (attempt === MAX_RETRY_COUNT) {
        throw error;
      }

      options.retryCount = Math.max(options.retryCount || 0, attempt + 1);

      emitProgress(options, {
        stage: 'retry',
        workItemIndex: workItem.index + 1,
        retryCount: attempt + 1,
        totalWorkItems: options.totalWorkItems,
        completedWorkItems: options.completedWorkItems,
        message: error.message
      });

      await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  return [];
}

function buildCacheKey(entry, options) {
  return createHash('sha256')
    .update(JSON.stringify([
      CACHE_KEY_VERSION,
      options.targetLanguage,
      options.model,
      options.baseUrl,
      buildSystemPrompt(options, 1),
      entry.original
    ]))
    .digest('hex');
}

async function loadTranslationCache(cacheFile) {
  if (!cacheFile) {
    return {};
  }

  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

async function saveTranslationCache(cacheFile, cache) {
  if (!cacheFile) {
    return;
  }

  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
}

async function processWorkItems(workItems, options, translator, cacheContext) {
  const results = new Map();
  let nextIndex = 0;
  let cacheWritePromise = Promise.resolve();
  options.completedWorkItems = 0;
  options.retryCount = 0;

  const queueCacheSave = () => {
    if (!cacheContext.cacheFile) {
      return;
    }

    cacheWritePromise = cacheWritePromise.then(() => saveTranslationCache(cacheContext.cacheFile, cacheContext.cache));
  };

  async function worker() {
    while (nextIndex < workItems.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const translatedEntries = await translateWorkItemWithRetry(workItems[currentIndex], options, translator);
      translatedEntries.forEach((entry) => {
        results.set(entry.id, entry.content);
        const sourceEntry = cacheContext.entryById.get(entry.id);

        if (isReusableTranslation(sourceEntry, entry.content, options)) {
          cacheContext.cache[sourceEntry.cacheKey] = entry.content;
        } else {
          delete cacheContext.cache[sourceEntry.cacheKey];
        }
      });
      queueCacheSave();
      options.completedWorkItems += 1;
      emitProgress(options, {
        stage: 'progress',
        totalWorkItems: options.totalWorkItems,
        completedWorkItems: options.completedWorkItems,
        remainingWorkItems: options.totalWorkItems - options.completedWorkItems,
        translatedEntryCount: options.translatedEntryCount,
        skippedChunkCount: options.skippedChunkCount,
        cacheHitCount: options.cacheHitCount,
        concurrency: options.concurrency,
        currentWorkItemIndex: currentIndex + 1
      });
    }
  }

  const workerCount = Math.min(options.concurrency, workItems.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  await cacheWritePromise;
  return results;
}

async function translateMarkdownInternal(markdown, incomingOptions, translator) {
  const options = normalizeOptions(incomingOptions);
  const sections = splitMarkdownIntoSections(markdown);
  const entries = buildChunkEntries(sections, options);
  const translatableEntries = entries.filter((entry) => entry.shouldTranslate);
  const cache = await loadTranslationCache(options.cacheFile);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const translatedResults = new Map();
  const pendingEntries = [];

  for (const entry of translatableEntries) {
    const cacheKey = buildCacheKey(entry, options);
    entry.cacheKey = cacheKey;
    if (typeof cache[cacheKey] === 'string' && isReusableTranslation(entry, cache[cacheKey], options)) {
      translatedResults.set(entry.id, cache[cacheKey]);
      continue;
    }

    delete cache[cacheKey];

    pendingEntries.push(entry);
  }

  const workItems = buildWorkItems(pendingEntries, options);
  options.totalWorkItems = workItems.length;
  options.totalEntryCount = entries.length;
  options.translatedEntryCount = translatableEntries.length;
  options.skippedChunkCount = entries.filter((entry) => !entry.shouldTranslate).length;
  options.cacheHitCount = translatableEntries.length - pendingEntries.length;

  workItems.forEach((workItem, index) => {
    workItem.index = index;
  });

  emitProgress(options, {
    stage: 'start',
    totalWorkItems: options.totalWorkItems,
    totalEntryCount: options.totalEntryCount,
    translatedEntryCount: options.translatedEntryCount,
    skippedChunkCount: options.skippedChunkCount,
    cacheHitCount: options.cacheHitCount,
    concurrency: options.concurrency
  });

  if (workItems.length > 0) {
    const processedResults = await processWorkItems(workItems, options, translator, {
      cache,
      cacheFile: options.cacheFile,
      entryById
    });
    processedResults.forEach((value, key) => {
      translatedResults.set(key, value);
    });
  }

  if (options.cacheFile && workItems.length === 0) {
    await saveTranslationCache(options.cacheFile, cache);
  }

  const translatedSections = sections.map((section, sectionIndex) => {
    if (section.type === 'passthrough' || !section.content.trim()) {
      if (section.type === 'translatable-fence') {
        const openingFence = section.openingFence || '```';
        const closingFence = section.closingFence ? `\n${section.closingFence}` : '';
        return `${openingFence}${closingFence}`;
      }

      return section.content;
    }

    const sectionEntries = entries
      .filter((entry) => entry.sectionIndex === sectionIndex)
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .map((entry) => translatedResults.get(entry.id) || entry.original);

    if (section.type === 'translatable-fence') {
      const openingFence = section.openingFence || '```';
      const closingFence = section.closingFence ? `\n${section.closingFence}` : '';
      return `${openingFence}\n${sectionEntries.map((entry) => stripAccidentalOuterFence(entry)).join('\n')}${closingFence}`;
    }

    return sectionEntries.join('\n\n');
  });

  return {
    content: translatedSections.join('\n'),
    translatedChunkCount: workItems.length,
    skippedChunkCount: options.skippedChunkCount,
    totalEntryCount: options.totalEntryCount,
    translatedEntryCount: options.translatedEntryCount,
    cacheHitCount: options.cacheHitCount,
    concurrency: options.concurrency,
    retryCount: options.retryCount || 0,
    cacheFile: options.cacheFile
  };
}

export function createTranslationRuntime({ translator = requestTranslation } = {}) {
  return {
    async translateMarkdown(markdown, options) {
      return translateMarkdownInternal(markdown, options, translator);
    }
  };
}

const defaultRuntime = createTranslationRuntime();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.inputPath) {
    throw new Error('Missing required --input argument');
  }

  options.apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
  if (!options.apiKey) {
    throw new Error('Missing DeepSeek API key. Use --api-key or DEEPSEEK_API_KEY.');
  }

  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath || buildOutputPath(inputPath, options.targetLanguage));
  const cacheFile = resolveCacheFilePath(inputPath, options.cacheFile);
  const originalMarkdown = await readFile(inputPath, 'utf8');
  const startedAt = Date.now();
  const translated = await defaultRuntime.translateMarkdown(originalMarkdown, {
    ...options,
    inputPath,
    cacheFile
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, translated.content, 'utf8');

  const result = {
    inputPath,
    outputPath,
    targetLanguage: options.targetLanguage,
    model: options.model,
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

  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Source markdown: ${result.inputPath}`);
  console.log(`Translated markdown: ${result.outputPath}`);
  console.log(`Target language: ${result.targetLanguage}`);
  console.log(`Chunks translated: ${result.translatedChunkCount}`);
  console.log(`Chunks skipped: ${result.skippedChunkCount}`);
  console.log(`Cache hits: ${result.cacheHitCount}`);
  console.log(`Elapsed ms: ${result.elapsedMs}`);
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
