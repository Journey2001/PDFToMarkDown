import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const options = { json: false };

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

    if (arg === '--rules-file') {
      options.rulesFile = argv[index + 1];
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
    'Clean a local Markdown file with configurable regex rules and write a sibling file.',
    '',
    'Usage:',
    '  node scripts/clean-markdown.mjs --input <file.md> --rules-file <rules.json> [options]',
    '',
    'Options:',
    '  --input       Local markdown file to clean',
    '  --output      Optional output markdown path',
    '  --rules-file  JSON file containing regex cleanup rules',
    '  --json        Print machine-readable JSON result',
    '  --help, -h    Show this help message'
  ].join('\n'));
}

function buildOutputPath(inputPath) {
  const extension = path.extname(inputPath);
  const baseName = path.basename(inputPath, extension);
  return path.join(path.dirname(inputPath), `${baseName}.cleaned${extension}`);
}

function normalizeRules(rawRules) {
  if (!Array.isArray(rawRules)) {
    throw new Error('Cleanup rules JSON must be an array');
  }

  return rawRules
    .filter((rule) => rule && rule.enabled !== false && rule.pattern)
    .map((rule, index) => ({
      id: rule.id || `rule-${index + 1}`,
      name: rule.name || `Rule ${index + 1}`,
      pattern: rule.pattern,
      flags: rule.flags || 'gm',
      replacement: typeof rule.replacement === 'string' ? rule.replacement : ''
    }));
}

export function renumberCaseHeadings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = /^(\s{0,3}#{1,6}\s+(?:\*\*)?(?:Case|案例)\s*)\d+(.*)$/;
  const fencePattern = /^\s*(```|~~~)/;
  let caseNumber = 1;
  let inFence = false;
  let renamedCount = 0;

  const output = lines.map((line) => {
    if (fencePattern.test(line)) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    const match = line.match(headingPattern);
    if (!match) {
      return line;
    }

    const [, prefix, suffix] = match;
    renamedCount += 1;
    const renumberedLine = `${prefix}${caseNumber}${suffix}`;
    caseNumber += 1;
    return renumberedLine;
  });

  return {
    output: output.join('\n'),
    renamedCount
  };
}

export function applyCleanupRules(markdown, rules) {
  let output = markdown;
  const stats = [];

  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    const matchCount = [...output.matchAll(new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`))].length;
    output = output.replace(regex, rule.replacement);
    stats.push({
      id: rule.id,
      name: rule.name,
      matchCount
    });
  }

  const renumbered = renumberCaseHeadings(output);
  output = renumbered.output;
  stats.push({
    id: 'case-heading-renumber',
    name: 'Renumber Case headings',
    matchCount: renumbered.renamedCount
  });

  return { output, stats };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.inputPath) {
    throw new Error('Missing required --input argument');
  }

  if (!options.rulesFile) {
    throw new Error('Missing required --rules-file argument');
  }

  const inputPath = path.resolve(options.inputPath);
  const rulesFile = path.resolve(options.rulesFile);
  const outputPath = path.resolve(options.outputPath || buildOutputPath(inputPath));
  const markdown = await readFile(inputPath, 'utf8');
  const rules = normalizeRules(JSON.parse(await readFile(rulesFile, 'utf8')));
  const startedAt = Date.now();
  const { output, stats } = applyCleanupRules(markdown, rules);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, 'utf8');

  const result = {
    inputPath,
    outputPath,
    rulesFile,
    appliedRuleCount: stats.length,
    stats,
    elapsedMs: Date.now() - startedAt
  };

  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`Source markdown: ${result.inputPath}`);
  console.log(`Cleaned markdown: ${result.outputPath}`);
  console.log(`Rules file: ${result.rulesFile}`);
  console.log(`Applied rules: ${result.appliedRuleCount}`);
  console.log(`Elapsed ms: ${result.elapsedMs}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
