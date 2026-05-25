import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright';

const DEFAULT_OUTPUT_ROOT = path.resolve(process.cwd(), 'output');

const LANGUAGE_CONFIG = {
  en: {
    readmeFile: 'README.md',
    pdfFileName: 'awesome-gpt-image.en.pdf'
  },
  'zh-CN': {
    readmeFile: 'README.zh-CN.md',
    pdfFileName: 'awesome-gpt-image.zh-CN.pdf'
  },
  'zh-TW': {
    readmeFile: 'README.zh-TW.md',
    pdfFileName: 'awesome-gpt-image.zh-TW.pdf'
  }
};

function parseArgs(argv) {
  const options = {
    lang: 'zh-CN',
    outputRoot: DEFAULT_OUTPUT_ROOT,
    inputPath: null,
    githubUrl: null,
    stripSources: false,
    appendLicenseNote: false,
    licenseNote: '',
    watermarkText: '',
    json: false,
    markdownOnly: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--lang') {
      options.lang = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--output') {
      options.outputRoot = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--input') {
      options.inputPath = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--github-url') {
      options.githubUrl = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--strip-sources') {
      options.stripSources = true;
      continue;
    }

    if (arg === '--append-license-note') {
      options.appendLicenseNote = true;
      continue;
    }

    if (arg === '--license-note') {
      options.licenseNote = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--watermark') {
      options.watermarkText = argv[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (arg === '--markdown-only') {
      options.markdownOnly = true;
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
    'Usage:',
    '  node scripts/export-awesome-gpt-image-pdf.mjs --lang zh-CN',
    '',
    'Options:',
    '  --lang    en | zh-CN | zh-TW',
    '  --output  Output directory, default: output',
    '  --input   Local markdown file to render instead of refetching from GitHub',
    '  --github-url  Public GitHub Markdown URL to fetch and render',
    '  --strip-sources  Remove source citation lines before rendering',
    '  --append-license-note  Append the export-only license note block to HTML/PDF',
    '  --license-note <text>  Custom license note text appended when --append-license-note is enabled',
    '  --watermark  Add a low-contrast text watermark behind HTML/PDF content',
    '  --markdown-only  Only fetch and localize markdown without generating HTML/PDF',
    '  --json    Print machine-readable JSON result',
    '  --help    Show this help'
  ].join('\n'));
}

function getDefaultReadmeUrls(readmeFile) {
  return buildRemoteMarkdownTarget(
    `https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/${readmeFile}`
  );
}

function makeOutputSlug(parts) {
  return parts
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'markdown-export';
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function buildRemoteMarkdownTarget(rawMarkdownUrl, metadata = {}) {
  const url = new URL(rawMarkdownUrl);
  const normalizedUrl = new URL(url.toString());
  normalizedUrl.search = '';
  normalizedUrl.hash = '';

  const pathnameParts = normalizedUrl.pathname.split('/').filter(Boolean);
  const fileName = pathnameParts.at(-1) || 'README.md';
  const baseName = path.basename(fileName, path.extname(fileName));
  const assetBasePath = pathnameParts.slice(0, -1).join('/');
  const assetBase = `${normalizedUrl.origin}/${assetBasePath ? `${assetBasePath}/` : ''}`;
  const outputSlug = metadata.outputSlug || makeOutputSlug([
    metadata.owner,
    metadata.repo,
    baseName,
    createHash('sha1').update(normalizedUrl.toString()).digest('hex').slice(0, 8)
  ]);

  return {
    inputPath: null,
    sourceUrl: metadata.sourceUrl || normalizedUrl.toString(),
    originalMarkdownUrl: normalizedUrl.toString(),
    originalMarkdown: null,
    assetBase: ensureTrailingSlash(assetBase),
    outputSlug,
    fileName,
    baseName,
    title: fileName
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 PDFToMarkdown/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${url} (${response.status})`);
  }

  return response.text();
}

async function resolveGitHubMarkdownTarget(githubUrl) {
  const normalizedInput = new URL(githubUrl);
  normalizedInput.hash = '';
  const normalizedInputString = normalizedInput.toString();

  if (normalizedInput.hostname === 'raw.githubusercontent.com') {
    const pathnameParts = normalizedInput.pathname.split('/').filter(Boolean);
    return buildRemoteMarkdownTarget(normalizedInputString, {
      sourceUrl: githubUrl,
      owner: pathnameParts[0],
      repo: pathnameParts[1]
    });
  }

  if (normalizedInput.hostname !== 'github.com') {
    throw new Error('--github-url only supports public GitHub markdown URLs');
  }

  const html = await fetchText(normalizedInputString);
  const rawLinkMatch = html.match(/href="([^"]+\/raw\/[^"]+\.md(?:[^"]*)?)"/i);

  if (!rawLinkMatch) {
    throw new Error(`Could not find a Raw markdown link on: ${githubUrl}`);
  }

  const rawUrl = new URL(rawLinkMatch[1], normalizedInput.origin).toString();
  const pathParts = normalizedInput.pathname.split('/').filter(Boolean);
  return buildRemoteMarkdownTarget(rawUrl, {
    sourceUrl: githubUrl,
    owner: pathParts[0],
    repo: pathParts[1]
  });
}

function shouldDownloadImageSource(source) {
  return !/^(?:data:|mailto:|#)/i.test(source);
}

function ensureAbsoluteAssetUrl(source, assetBaseUrl) {
  if (/^https?:\/\//i.test(source)) {
    return source;
  }

  return new URL(source, assetBaseUrl).toString();
}

function getFileExtensionFromUrl(url, contentType) {
  const pathname = new URL(url).pathname;
  const rawExtension = path.extname(pathname).toLowerCase();
  if (rawExtension) {
    return rawExtension;
  }

  const normalizedType = (contentType || '').split(';')[0].trim().toLowerCase();
  const contentTypeMap = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg'
  };

  return contentTypeMap[normalizedType] || '.bin';
}

function buildAssetHash(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function buildLocalAssetName(url, contentType) {
  const hash = buildAssetHash(url);
  return `${hash}${getFileExtensionFromUrl(url, contentType)}`;
}

function findExistingCachedAsset(url, existingAssetFiles) {
  const hash = buildAssetHash(url);

  for (const fileName of existingAssetFiles) {
    if (fileName.startsWith(`${hash}.`)) {
      return `assets/${fileName}`;
    }
  }

  return null;
}

async function downloadAsset(url, assetsDir, cache, existingAssetFiles, stats) {
  if (cache.has(url)) {
    return cache.get(url);
  }

  const existingAsset = findExistingCachedAsset(url, existingAssetFiles);
  if (existingAsset) {
    cache.set(url, existingAsset);
    stats.reusedImageCount += 1;
    return existingAsset;
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 PDFToMarkdown/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download asset: ${url} (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const fileName = buildLocalAssetName(url, response.headers.get('content-type'));
  const targetPath = path.join(assetsDir, fileName);
  await writeFile(targetPath, Buffer.from(arrayBuffer));
  existingAssetFiles.add(fileName);
  stats.downloadedImageCount += 1;

  const relativePath = `assets/${fileName}`;
  cache.set(url, relativePath);
  return relativePath;
}

function collectImageSources(markdown) {
  const sources = new Set();
  const markdownImageRegex = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const htmlImageRegex = /<img\b[^>]*?src=["']([^"']+)["'][^>]*>/gi;

  for (const regex of [markdownImageRegex, htmlImageRegex]) {
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      const source = match[1].trim();
      if (source) {
        sources.add(source);
      }
    }
  }

  return [...sources];
}

function replaceAllImageSources(markdown, replacements) {
  let output = markdown;

  for (const [originalSource, localSource] of replacements.entries()) {
    output = output.split(`(${originalSource})`).join(`(${localSource})`);
    output = output.split(`src="${originalSource}"`).join(`src="${localSource}"`);
    output = output.split(`src='${originalSource}'`).join(`src='${localSource}'`);
  }

  return output;
}

function stripSourceLines(markdown) {
  return markdown
    .replace(/^\*\*鏉ユ簮:\*\*.*$(\r?\n)?/gm, '')
    .replace(/^\*鏉ユ簮:.*\*$(\r?\n)?/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

function stripImageOnlyLinks(html) {
  return html.replace(/<a\b([^>]*)>(\s*<img\b[^>]*>\s*)<\/a>/gi, '$2');
}

function keepOnlyAnchorLinks(html) {
  return html.replace(
    /<a\b([^>]*?)href=(['"])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi,
    (fullMatch, beforeHref, quote, href, afterHref, innerHtml) => {
      if (href.trim().startsWith('#')) {
        return fullMatch;
      }

      return innerHtml;
    }
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLicenseNotice(options = {}) {
  if (!options.appendLicenseNote) {
    return '';
  }

  const lines = String(options.licenseNote || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const paragraphs = lines
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('\n        ');

  return `
      <section class="export-license-note">
        <h2>许可说明</h2>
        ${paragraphs}
      </section>`;
}

function applyPdfKeepTogetherMarkers(html) {
  return html
    .replace(/<!--\s*pdf:keep-together:start\s*-->/gi, '<section class="pdf-keep-together">')
    .replace(/<!--\s*pdf:keep-together:end\s*-->/gi, '</section>');
}

function renderHtml(markdown, title, options = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false
  });

  const content = md.render(markdown);
  const sanitizedContent = applyPdfKeepTogetherMarkers(
    keepOnlyAnchorLinks(stripImageOnlyLinks(content))
  );
  const watermarkText = typeof options.watermarkText === 'string' ? options.watermarkText.trim() : '';
  const watermarkLayer = watermarkText
    ? `
      <div class="pdf-watermark" aria-hidden="true">
        <span class="pdf-watermark-mark pdf-watermark-top-left">${escapeHtml(watermarkText)}</span>
        <span class="pdf-watermark-mark pdf-watermark-center">${escapeHtml(watermarkText)}</span>
        <span class="pdf-watermark-mark pdf-watermark-bottom-right">${escapeHtml(watermarkText)}</span>
      </div>`
    : '';
  const licenseNotice = renderLicenseNotice(options);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
        --text: #1f2328;
        --muted: #59636e;
        --border: #d0d7de;
        --surface: #ffffff;
        --surface-alt: #f6f8fa;
        --link: #0969da;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--text);
        background: var(--surface);
        font: 14px/1.6 "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      }

      main {
        width: 100%;
        max-width: 1080px;
        margin: 0 auto;
        padding: 24px 32px 48px;
        position: relative;
        z-index: 1;
      }

      h1, h2, h3, h4, h5, h6 {
        line-height: 1.3;
        margin: 1.4em 0 0.6em;
        page-break-after: avoid;
      }

      h1 {
        font-size: 2rem;
        border-bottom: 1px solid var(--border);
        padding-bottom: 0.3em;
      }

      h2 {
        font-size: 1.5rem;
        border-bottom: 1px solid var(--border);
        padding-bottom: 0.2em;
      }

      p, ul, ol, table, pre, blockquote {
        margin: 0 0 1em;
      }

      a {
        color: var(--link);
        text-decoration: none;
      }

      img {
        display: block;
        max-width: 100%;
        height: auto;
        margin: 12px auto;
        page-break-inside: avoid;
      }

      .pdf-keep-together {
        break-inside: avoid-page;
        page-break-inside: avoid;
      }

      .pdf-watermark {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 0;
      }

      .pdf-watermark-mark {
        position: absolute;
        color: rgba(31, 35, 40, 0.08);
        font-size: 46px;
        font-weight: 700;
        letter-spacing: 0.12em;
        transform: rotate(-28deg);
        white-space: nowrap;
      }

      .pdf-watermark-top-left {
        top: 14%;
        left: 6%;
        transform-origin: top left;
      }

      .pdf-watermark-center {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%) rotate(-28deg);
      }

      .pdf-watermark-bottom-right {
        right: 6%;
        bottom: 14%;
        transform-origin: bottom right;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        display: table;
        overflow: visible;
      }

      th, td {
        border: 1px solid var(--border);
        padding: 8px;
        text-align: center;
        vertical-align: middle;
      }

      th {
        background: var(--surface-alt);
      }

      pre, code {
        font-family: "Cascadia Code", Consolas, monospace;
      }

      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: var(--surface-alt);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 12px;
      }

      code {
        background: var(--surface-alt);
        padding: 0.1em 0.3em;
        border-radius: 4px;
      }

      pre code {
        background: transparent;
        padding: 0;
      }

      blockquote {
        margin-left: 0;
        padding-left: 1em;
        color: var(--muted);
        border-left: 4px solid var(--border);
      }

      hr {
        border: 0;
        border-top: 1px solid var(--border);
        margin: 2em 0;
      }

      .export-license-note {
        margin-top: 3rem;
        padding: 16px 18px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface-alt);
        color: var(--muted);
        font-size: 13px;
      }

      .export-license-note h2 {
        margin-top: 0;
        border-bottom: 0;
        padding-bottom: 0;
        font-size: 1.2rem;
        color: var(--text);
      }

      .export-license-note p:last-child {
        margin-bottom: 0;
      }

      @page {
        size: A4;
        margin: 14mm 12mm 14mm 12mm;
      }
    </style>
  </head>
  <body>
    ${watermarkLayer}
    <main>
      ${sanitizedContent}
      ${licenseNotice}
    </main>
  </body>
</html>`;
}

async function loadMarkdown(options, languageConfig) {
  if (options.inputPath) {
    const originalMarkdown = await readFile(options.inputPath, 'utf8');
    const fileName = path.basename(options.inputPath);
    const baseName = path.basename(options.inputPath, path.extname(options.inputPath));
    return {
      inputPath: options.inputPath,
      sourceUrl: options.inputPath,
      originalMarkdown,
      assetBase: null,
      outputDir: path.dirname(options.inputPath),
      markdownPath: options.inputPath,
      htmlPath: options.inputPath.replace(/\.md$/i, '.html'),
      pdfPath: path.join(path.dirname(options.inputPath), `${baseName}.pdf`),
      fileName,
      title: fileName,
      baseName
    };
  }

  if (options.githubUrl) {
    const remoteTarget = await resolveGitHubMarkdownTarget(options.githubUrl);
    const originalMarkdown = await fetchText(remoteTarget.originalMarkdownUrl);
    const outputDir = path.join(options.outputRoot, remoteTarget.outputSlug);
    return {
      ...remoteTarget,
      originalMarkdown,
      outputDir,
      markdownPath: path.join(outputDir, remoteTarget.fileName),
      htmlPath: path.join(outputDir, `${remoteTarget.baseName}.html`),
      pdfPath: path.join(outputDir, `${remoteTarget.baseName}.pdf`)
    };
  }

  const defaultTarget = getDefaultReadmeUrls(languageConfig.readmeFile);
  const outputDir = path.join(options.outputRoot, options.lang);
  const originalMarkdown = await fetchText(defaultTarget.originalMarkdownUrl);
  return {
    ...defaultTarget,
    originalMarkdown,
    outputDir,
    markdownPath: path.join(outputDir, languageConfig.readmeFile),
    htmlPath: path.join(outputDir, languageConfig.readmeFile.replace(/\.md$/i, '.html')),
    pdfPath: path.join(outputDir, languageConfig.pdfFileName)
  };
}

export async function materializeMarkdownBundle(bundle) {
  await mkdir(path.dirname(bundle.markdownPath), { recursive: true });
  await writeFile(bundle.markdownPath, bundle.markdown, 'utf8');
  return {
    markdownPath: bundle.markdownPath,
    sourceUrl: bundle.sourceUrl || null,
    imageCount: bundle.imageCount || 0,
    downloadedImageCount: bundle.downloadedImageCount || 0,
    reusedImageCount: bundle.reusedImageCount || 0
  };
}

async function defaultPdfRenderer({ htmlPath, pdfPath }) {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '14mm',
        right: '12mm',
        bottom: '14mm',
        left: '12mm'
      }
    });
  } finally {
    await browser.close();
  }
}

export async function renderMarkdownArtifacts(bundle, { pdfRenderer = defaultPdfRenderer } = {}) {
  const html = renderHtml(bundle.markdown, bundle.title, {
    appendLicenseNote: bundle.appendLicenseNote,
    licenseNote: bundle.licenseNote,
    watermarkText: bundle.watermarkText
  });

  await mkdir(path.dirname(bundle.htmlPath), { recursive: true });
  await writeFile(bundle.htmlPath, html, 'utf8');
  await pdfRenderer({ htmlPath: bundle.htmlPath, pdfPath: bundle.pdfPath });

  return {
    htmlPath: bundle.htmlPath,
    pdfPath: bundle.pdfPath
  };
}

export async function fetchMarkdownBundle(options) {
  const languageConfig = LANGUAGE_CONFIG[options.lang];
  if (!languageConfig) {
    throw new Error(`Unsupported language: ${options.lang}`);
  }

  const loaded = await loadMarkdown(options, languageConfig);
  const outputDir = loaded.outputDir;
  const assetsDir = path.join(outputDir, 'assets');

  await mkdir(assetsDir, { recursive: true });

  const workingMarkdown = options.stripSources
    ? stripSourceLines(loaded.originalMarkdown)
    : loaded.originalMarkdown;

  const originalMarkdown = workingMarkdown;
  const imageSources = collectImageSources(originalMarkdown);
  const assetCache = new Map();
  const replacements = new Map();
  const existingAssetFiles = new Set(await readdir(assetsDir));
  const stats = {
    downloadedImageCount: 0,
    reusedImageCount: 0
  };

  for (const source of imageSources) {
    if (!shouldDownloadImageSource(source)) {
      continue;
    }

    if (loaded.inputPath && !/^https?:\/\//i.test(source)) {
      continue;
    }

    const absoluteUrl = ensureAbsoluteAssetUrl(source, loaded.assetBase);
    const localSource = await downloadAsset(absoluteUrl, assetsDir, assetCache, existingAssetFiles, stats);
    replacements.set(source, localSource);
  }

  const localizedMarkdown = replaceAllImageSources(originalMarkdown, replacements);

  return {
    markdown: localizedMarkdown,
    markdownPath: loaded.markdownPath,
    htmlPath: loaded.htmlPath,
    pdfPath: loaded.pdfPath,
    title: loaded.title || languageConfig.readmeFile,
    sourceUrl: loaded.sourceUrl || null,
    imageCount: imageSources.length,
    downloadedImageCount: stats.downloadedImageCount,
    reusedImageCount: stats.reusedImageCount
  };
}

export async function exportPdf(options) {
  const bundle = await fetchMarkdownBundle(options);
  const materialized = await materializeMarkdownBundle(bundle);

  if (options.markdownOnly) {
    return materialized;
  }

  const rendered = await renderMarkdownArtifacts({
    ...bundle,
    appendLicenseNote: options.appendLicenseNote,
    licenseNote: options.licenseNote,
    watermarkText: options.watermarkText
  });

  return {
    ...materialized,
    ...rendered
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printHelp();
    return;
  }

  const result = await exportPdf(options);
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Localized markdown: ${result.markdownPath}`);
  if (result.htmlPath) {
    console.log(`Preview HTML: ${result.htmlPath}`);
  }
  if (result.pdfPath) {
    console.log(`PDF output: ${result.pdfPath}`);
  }
  console.log(`Images localized: ${result.imageCount}`);
  console.log(`Images downloaded: ${result.downloadedImageCount}`);
  console.log(`Images reused: ${result.reusedImageCount}`);
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
