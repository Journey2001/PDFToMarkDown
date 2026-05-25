import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_TARGET_LANGUAGE = 'zh-CN';
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
    maxChars: DEFAULT_MAX_CHARS,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--broken') {
      options.brokenPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--translated-input') {
      options.translatedInputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--source') {
      options.sourcePath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--output') {
      options.outputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--max-chars') {
      options.maxChars = Number(argv[index + 1]) || DEFAULT_MAX_CHARS;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
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
    'Repair leaked __PDF_MD_TOKEN_* placeholders in a translated Markdown file.',
    '',
    'Usage:',
    '  node scripts/repair-translated-placeholders.mjs --broken <bad.md> --translated-input <previous.md> --source <clean.md> [options]',
    '',
    'Options:',
    '  --broken            Broken translated Markdown file containing __PDF_MD_TOKEN_* placeholders',
    '  --translated-input  Markdown that was used as input to the failed translation run',
    '  --source            Clean source Markdown with real image/link content',
    '  --output            Optional output path (default: sibling *.repaired.md)',
    '  --max-chars         Chunking hint used during translation (default: 12000)',
    '  --json              Print machine-readable JSON result',
    '  --help, -h          Show this help message'
  ].join('\n'));
}

function buildOutputPath(brokenPath) {
  const extension = path.extname(brokenPath);
  const baseName = path.basename(brokenPath, extension);
  return path.join(path.dirname(brokenPath), `${baseName}.repaired${extension}`);
}

function shouldPassthroughFence(openingFenceLine) {
  const match = openingFenceLine.match(/^```\s*([^\s]+)?/);
  const language = (match?.[1] || '').toLowerCase();
  if (!language) {
    return false;
  }

  return PASSTHROUGH_FENCE_LANGUAGES.has(language);
}

function splitMarkdownIntoSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let buffer = [];
  let inCodeFence = false;
  let currentFenceType = 'translate';

  const flush = (type) => {
    if (buffer.length === 0) {
      return;
    }

    sections.push({
      type,
      content: buffer.join('\n')
    });
    buffer = [];
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (/^```/.test(trimmedLine)) {
      if (inCodeFence) {
        buffer.push(line);
        if (currentFenceType === 'passthrough') {
          flush('passthrough');
        }
        inCodeFence = false;
        currentFenceType = 'translate';
      } else {
        const passthroughFence = shouldPassthroughFence(trimmedLine);
        if (passthroughFence) {
          flush('translate');
          currentFenceType = 'passthrough';
        } else {
          currentFenceType = 'translate';
        }

        buffer.push(line);
        inCodeFence = true;
      }
      continue;
    }

    buffer.push(line);
  }

  flush(inCodeFence ? 'passthrough' : 'translate');
  return sections;
}

function splitTranslatableSection(content, maxChars) {
  const normalized = content.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }
  };

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;

    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    flush();

    if (paragraph.length <= maxChars) {
      buffer = paragraph;
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
      buffer = lineBuffer;
    }
  }

  flush();
  return chunks;
}

function shouldTranslateChunk(chunk, options) {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return false;
  }

  if (options.targetLanguage !== 'zh-CN') {
    return true;
  }

  return /[A-Za-z\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(trimmed);
}

function buildChunkEntries(sections, options) {
  const entries = [];
  let entryId = 0;

  sections.forEach((section, sectionIndex) => {
    if (section.type === 'passthrough' || !section.content.trim()) {
      return;
    }

    const chunks = splitTranslatableSection(section.content, options.maxChars);
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

function buildProtectedToken(segmentId, tokenIndex) {
  return `__PDF_MD_TOKEN_${segmentId}_${tokenIndex}__`;
}

function maskProtectedTokens(content, segmentId) {
  const tokens = [];
  let masked = content;

  const protect = (regex) => {
    masked = masked.replace(regex, (match) => {
      const token = buildProtectedToken(segmentId, tokens.length);
      tokens.push({ token, value: match });
      return token;
    });
  };

  protect(/<a\b[^>]*?>[\s\S]*?<\/a>/gi);
  protect(/<img\b[^>]*?>/gi);
  protect(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
  protect(/<[^>]+>/g);
  protect(/`[^`\n]+`/g);
  protect(/https?:\/\/[^\s)"'>]+/g);

  return { masked, tokens };
}

function collectImageRows(markdown) {
  return Array.from(markdown.matchAll(/^\|\s*<a href=.*?<img .*?<\/a>\s*\|\s*$/gm), (match) => match[0]);
}

function collectImageAnchors(markdown) {
  return collectImageRows(markdown).map((row) => {
    const match = row.match(/<a\b[^>]*?>[\s\S]*?<\/a>/i);
    if (!match) {
      throw new Error('Failed to extract image anchor from source markdown row');
    }

    return match[0];
  });
}

function applyProtectedTokenRepair(brokenMarkdown, translatedInputMarkdown, sourceMarkdown, options) {
  const sourceAnchors = collectImageAnchors(sourceMarkdown);
  const sections = splitMarkdownIntoSections(translatedInputMarkdown);
  const entries = buildChunkEntries(sections, options);
  const translatedEntries = entries.filter((entry) => entry.shouldTranslate);

  let repaired = brokenMarkdown;
  let replacementCount = 0;
  let imageAnchorIndex = 0;

  translatedEntries.forEach((entry) => {
    const { tokens } = maskProtectedTokens(entry.original, entry.id);
    tokens.forEach(({ token, value }) => {
      let resolvedValue = value;

      if (/^<a href="__PROTECTED_TOKEN_\d+__"[^>]*><img\b[^>]*><\/a>$/i.test(value)) {
        resolvedValue = sourceAnchors[imageAnchorIndex];
        imageAnchorIndex += 1;
        if (!resolvedValue) {
          throw new Error('Source image anchors are fewer than legacy protected image tokens');
        }
      }

      const occurrences = repaired.split(token).length - 1;
      if (occurrences > 0) {
        repaired = repaired.split(token).join(resolvedValue);
        replacementCount += occurrences;
      }
    });
  });

  if (imageAnchorIndex !== sourceAnchors.length) {
    throw new Error(`Image anchor count mismatch: consumed ${imageAnchorIndex}, source has ${sourceAnchors.length}`);
  }

  const remainingTokens = Array.from(new Set(repaired.match(/__PDF_MD_TOKEN_\d+_\d+__/g) || []));

  return {
    repaired,
    translatedEntryCount: translatedEntries.length,
    replacementCount,
    remainingTokens,
    imageRowCount: imageAnchorIndex
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.brokenPath || !options.translatedInputPath || !options.sourcePath) {
    throw new Error('Missing required arguments: --broken, --translated-input, and --source are required');
  }

  const outputPath = options.outputPath || buildOutputPath(options.brokenPath);
  const [brokenMarkdown, translatedInputMarkdown, sourceMarkdown] = await Promise.all([
    readFile(options.brokenPath, 'utf8'),
    readFile(options.translatedInputPath, 'utf8'),
    readFile(options.sourcePath, 'utf8')
  ]);

  const repairResult = applyProtectedTokenRepair(brokenMarkdown, translatedInputMarkdown, sourceMarkdown, options);

  if (repairResult.remainingTokens.length > 0) {
    throw new Error(`Repair incomplete, remaining placeholders: ${repairResult.remainingTokens.join(', ')}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, repairResult.repaired, 'utf8');

  const result = {
    brokenPath: path.resolve(options.brokenPath),
    translatedInputPath: path.resolve(options.translatedInputPath),
    sourcePath: path.resolve(options.sourcePath),
    outputPath: path.resolve(outputPath),
    imageRowCount: repairResult.imageRowCount,
    translatedEntryCount: repairResult.translatedEntryCount,
    replacementCount: repairResult.replacementCount
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Repaired markdown written to: ${result.outputPath}`);
  console.log(`Image rows repaired: ${result.imageRowCount}`);
  console.log(`Protected token replacements: ${result.replacementCount}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});