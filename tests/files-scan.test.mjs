import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';

import { sendJson } from '../server/shared/http.mjs';
import { isPathInsideRoot, scanMarkdownFiles } from '../server/shared/files.mjs';

async function withTempDir(run) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-to-markdown-files-'));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test('isPathInsideRoot 允许根目录内路径并拒绝越界路径', async () => {
  await withTempDir(async (rootDir) => {
    const nestedDir = path.join(rootDir, 'docs', 'guide');
    await mkdir(nestedDir, { recursive: true });

    assert.equal(isPathInsideRoot(rootDir, rootDir), true);
    assert.equal(isPathInsideRoot(path.join(nestedDir, 'README.md'), rootDir), true);
    assert.equal(isPathInsideRoot(path.resolve(rootDir, '..', 'escape.md'), rootDir), false);
  });
});

test('isPathInsideRoot 会拒绝通过符号链接或 junction 指向根目录外的路径', async (context) => {
  await withTempDir(async (rootDir) => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'pdf-to-markdown-outside-'));
    const linkPath = path.join(rootDir, 'linked-outside');
    const escapedFile = path.join(linkPath, 'escape.md');

    try {
      await mkdir(rootDir, { recursive: true });
      await writeFile(path.join(outsideDir, 'escape.md'), '# escape\n', 'utf8');

      try {
        await symlink(
          outsideDir,
          linkPath,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      } catch (error) {
        context.skip(`当前环境无法创建目录链接: ${error.message}`);
        return;
      }

      assert.equal(isPathInsideRoot(escapedFile, rootDir), false);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('scanMarkdownFiles 递归扫描指定顶层目录并忽略 .git 和 node_modules', async () => {
  await withTempDir(async (rootDir) => {
    await mkdir(path.join(rootDir, 'docs', 'nested'), { recursive: true });
    await mkdir(path.join(rootDir, '.git', 'objects'), { recursive: true });
    await mkdir(path.join(rootDir, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(rootDir, 'scripts'), { recursive: true });

    await writeFile(path.join(rootDir, 'README.md'), '# root\n', 'utf8');
    await writeFile(path.join(rootDir, 'docs', 'guide.md'), '# guide\n', 'utf8');
    await writeFile(path.join(rootDir, 'docs', 'nested', 'deep.MD'), '# deep\n', 'utf8');
    await writeFile(path.join(rootDir, 'docs', 'ignore.txt'), 'skip\n', 'utf8');
    await writeFile(path.join(rootDir, '.git', 'hidden.md'), '# hidden\n', 'utf8');
    await writeFile(path.join(rootDir, 'node_modules', 'pkg', 'package.md'), '# package\n', 'utf8');
    await writeFile(path.join(rootDir, 'scripts', 'not-markdown.js'), 'console.log(1);\n', 'utf8');

    const files = await scanMarkdownFiles(rootDir, rootDir);
    const relativePaths = new Set(files.map((entry) => entry.relativePath));

    assert.equal(files.length, 3);
    assert.equal(relativePaths.has('README.md'), true);
    assert.equal(relativePaths.has('docs/guide.md'), true);
    assert.equal(relativePaths.has('docs/nested/deep.MD'), true);

    for (const entry of files) {
      assert.equal(path.isAbsolute(entry.path), true);
      assert.equal(isPathInsideRoot(entry.path, rootDir), true);
    }
  });
});

test('sendJson 返回 JSON 响应', () => {
  const response = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };

  sendJson(response, 201, { ok: true, message: 'done' });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.headers, { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(response.body, JSON.stringify({ ok: true, message: 'done' }));
});
