import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  materializeMarkdownBundle,
  renderMarkdownArtifacts
} from '../scripts/export-awesome-gpt-image-pdf.mjs';

test('materializeMarkdownBundle 只写出 markdown 文件', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-fetch-'));
  const markdownPath = path.join(tempDir, 'README.md');
  const htmlPath = path.join(tempDir, 'README.html');
  const pdfPath = path.join(tempDir, 'README.pdf');

  try {
    const result = await materializeMarkdownBundle({
      markdown: '# Title\n\nHello world',
      markdownPath,
      htmlPath,
      pdfPath
    });

    assert.equal(result.markdownPath, markdownPath);
    assert.equal(await readFile(markdownPath, 'utf8'), '# Title\n\nHello world');
    await assert.rejects(() => access(htmlPath));
    await assert.rejects(() => access(pdfPath));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renderMarkdownArtifacts 从本地 markdown 生成 html/pdf', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-render-'));
  const markdownPath = path.join(tempDir, 'README.md');
  const htmlPath = path.join(tempDir, 'README.html');
  const pdfPath = path.join(tempDir, 'README.pdf');

  try {
    await writeFile(markdownPath, '# Title\n\nHello world', 'utf8');

    const result = await renderMarkdownArtifacts({
      markdown: '# Title\n\nHello world',
      title: 'README.md',
      htmlPath,
      pdfPath,
      appendLicenseNote: false
    }, {
      pdfRenderer: async ({ htmlPath: renderedHtmlPath, pdfPath: renderedPdfPath }) => {
        const html = await readFile(renderedHtmlPath, 'utf8');
        assert.match(html, /<h1>Title<\/h1>/);
        await writeFile(renderedPdfPath, 'fake pdf', 'utf8');
      }
    });

    assert.equal(result.htmlPath, htmlPath);
    assert.equal(result.pdfPath, pdfPath);
    assert.equal(await readFile(pdfPath, 'utf8'), 'fake pdf');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renderMarkdownArtifacts 支持 keep-together 标记用于 PDF 分页控制', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-keep-together-'));
  const htmlPath = path.join(tempDir, 'README.html');
  const pdfPath = path.join(tempDir, 'README.pdf');

  try {
    await renderMarkdownArtifacts({
      markdown: [
        '# Title',
        '',
        '<!-- pdf:keep-together:start -->',
        '## Example 01',
        '',
        'Paragraph',
        '',
        '![Example](./images/example-01.png)',
        '<!-- pdf:keep-together:end -->'
      ].join('\n'),
      title: 'README.md',
      htmlPath,
      pdfPath,
      appendLicenseNote: false
    }, {
      pdfRenderer: async ({ htmlPath: renderedHtmlPath, pdfPath: renderedPdfPath }) => {
        const html = await readFile(renderedHtmlPath, 'utf8');
        assert.match(html, /<section class="pdf-keep-together">/);
        assert.match(html, /<section class="pdf-keep-together">[\s\S]*?<h2>Example 01<\/h2>[\s\S]*?<img src="\.\/images\/example-01\.png" alt="Example">[\s\S]*?<\/section>/);
        await writeFile(renderedPdfPath, 'fake pdf', 'utf8');
      }
    });

    assert.equal(await readFile(pdfPath, 'utf8'), 'fake pdf');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renderMarkdownArtifacts 会在内容下方渲染低对比度文字水印', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-watermark-'));
  const htmlPath = path.join(tempDir, 'README.html');
  const pdfPath = path.join(tempDir, 'README.pdf');

  try {
    await renderMarkdownArtifacts({
      markdown: '# Title\n\nHello world',
      title: 'README.md',
      htmlPath,
      pdfPath,
      appendLicenseNote: false,
      watermarkText: 'AI灵感仓库'
    }, {
      pdfRenderer: async ({ htmlPath: renderedHtmlPath, pdfPath: renderedPdfPath }) => {
        const html = await readFile(renderedHtmlPath, 'utf8');
        assert.match(html, /<div class="pdf-watermark" aria-hidden="true">/);
        assert.match(html, /pdf-watermark-top-left">AI灵感仓库<\/span>/);
        assert.match(html, /pdf-watermark-center">AI灵感仓库<\/span>/);
        assert.match(html, /pdf-watermark-bottom-right">AI灵感仓库<\/span>/);
        assert.match(html, /<main>[\s\S]*<h1>Title<\/h1>/);
        await writeFile(renderedPdfPath, 'fake pdf', 'utf8');
      }
    });

    assert.equal(await readFile(pdfPath, 'utf8'), 'fake pdf');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renderMarkdownArtifacts 会追加自定义许可说明', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-md-license-'));
  const htmlPath = path.join(tempDir, 'README.html');
  const pdfPath = path.join(tempDir, 'README.pdf');

  try {
    await renderMarkdownArtifacts({
      markdown: '# Title\n\nHello world',
      title: 'README.md',
      htmlPath,
      pdfPath,
      appendLicenseNote: true,
      licenseNote: '仅供个人学习与整理使用。\n请保留原项目链接。'
    }, {
      pdfRenderer: async ({ htmlPath: renderedHtmlPath, pdfPath: renderedPdfPath }) => {
        const html = await readFile(renderedHtmlPath, 'utf8');
        assert.match(html, /<section class="export-license-note">/);
        assert.match(html, /仅供个人学习与整理使用。/);
        assert.match(html, /请保留原项目链接。/);
        await writeFile(renderedPdfPath, 'fake pdf', 'utf8');
      }
    });

    assert.equal(await readFile(pdfPath, 'utf8'), 'fake pdf');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
