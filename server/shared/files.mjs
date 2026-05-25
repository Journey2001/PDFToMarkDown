import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function resolveForContainmentCheck(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const missingSegments = [];
  let currentPath = resolvedPath;

  while (true) {
    try {
      const realPath = realpathSync.native(currentPath);
      return missingSegments.length === 0
        ? realPath
        : path.resolve(realPath, ...missingSegments);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return resolvedPath;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return resolvedPath;
      }

      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export function isPathInsideRoot(candidatePath, rootPath) {
  const resolvedCandidatePath = resolveForContainmentCheck(candidatePath);
  const resolvedRootPath = resolveForContainmentCheck(rootPath);
  const relativePath = path.relative(resolvedRootPath, resolvedCandidatePath);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export async function scanMarkdownFiles(topLevelDir, relativeToRoot = topLevelDir) {
  const resolvedTopLevelDir = path.resolve(topLevelDir);
  const resolvedRelativeRoot = path.resolve(relativeToRoot);
  const files = [];
  const queue = [resolvedTopLevelDir];

  while (queue.length > 0) {
    const currentDir = queue.shift();
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      files.push({
        path: fullPath,
        relativePath: normalizeRelativePath(path.relative(resolvedRelativeRoot, fullPath))
      });
    }
  }

  return files;
}
