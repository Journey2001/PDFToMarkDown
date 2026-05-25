import test from 'node:test';
import assert from 'node:assert/strict';

import { applyCleanupRules, renumberCaseHeadings } from '../scripts/clean-markdown.mjs';

test('Case 标题会按出现顺序重新编号', () => {
  const input = [
    '# Demo',
    '',
    '### Case 1: First',
    'body',
    '### Case 3: Second',
    'body',
    '### Case 8: Third'
  ].join('\n');

  const result = renumberCaseHeadings(input);

  assert.match(result.output, /### Case 1: First/);
  assert.match(result.output, /### Case 2: Second/);
  assert.match(result.output, /### Case 3: Third/);
  assert.equal(result.renamedCount, 3);
});

test('重编号会跳过 fenced code block 中的 Case 文本', () => {
  const input = [
    '### Case 2: Visible',
    '',
    '```md',
    '### Case 999: Inside code',
    '```',
    '',
    '### Case 5: Visible Again'
  ].join('\n');

  const result = renumberCaseHeadings(input);

  assert.match(result.output, /### Case 1: Visible/);
  assert.match(result.output, /### Case 999: Inside code/);
  assert.match(result.output, /### Case 2: Visible Again/);
  assert.equal(result.renamedCount, 2);
});

test('中文案例标题也会按出现顺序重新编号并保留原格式', () => {
  const input = [
    '### 案例1：开头',
    'body',
    '### **案例 4：加粗标题**',
    'body',
    '### 案例9: 半角冒号',
    'body',
    '### Case 12: Mixed English Label'
  ].join('\n');

  const result = renumberCaseHeadings(input);

  assert.match(result.output, /### 案例1：开头/);
  assert.match(result.output, /### \*\*案例 2：加粗标题\*\*/);
  assert.match(result.output, /### 案例3: 半角冒号/);
  assert.match(result.output, /### Case 4: Mixed English Label/);
  assert.equal(result.renamedCount, 4);
});

test('清理流程在应用规则后会自动重排 Case 标题', () => {
  const markdown = [
    '### 案例4：Before',
    '**Source**: remove me',
    '',
    '### Case 9: After'
  ].join('\n');

  const rules = [
    {
      id: 'remove-source',
      name: 'Remove source line',
      pattern: '^\\*\\*Source\\*\\*:.*$\\n?',
      flags: 'gm',
      replacement: ''
    }
  ];

  const result = applyCleanupRules(markdown, rules);

  assert.match(result.output, /### 案例1：Before/);
  assert.match(result.output, /### Case 2: After/);
  assert.deepEqual(result.stats.map((item) => item.id), ['remove-source', 'case-heading-renumber']);
  assert.equal(result.stats[1].matchCount, 2);
});