import { postJson } from './api.js';

export async function scanMarkdownInto(selectElement, scanRoot, options = {}) {
  const scanMarkdown = typeof options.scanMarkdown === 'function'
    ? options.scanMarkdown
    : (payload) => postJson('/api/files/scan-markdown', payload);
  const payload = await scanMarkdown({ topLevelDir: scanRoot });
  const files = Array.isArray(payload.files) ? payload.files : [];

  selectElement.innerHTML = '';

  for (const file of files) {
    const option = selectElement.ownerDocument.createElement('option');
    option.value = file.path;
    option.textContent = file.relativePath || file.path;
    option.selected = true;
    selectElement.append(option);
  }

  return files;
}

export function getSelectedMarkdownPaths(selectElement) {
  return Array.from(selectElement.selectedOptions ?? [])
    .map((option) => option.value)
    .filter(Boolean);
}
