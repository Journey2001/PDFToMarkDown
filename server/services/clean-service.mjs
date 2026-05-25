import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createCleanService() {
  return {
    async run(options = {}) {
      const args = [
        'scripts/clean-markdown.mjs',
        '--input',
        options.markdownPath,
        '--rules-file',
        options.rulesFile,
        '--json'
      ];

      if (options.outputPath) {
        args.push('--output', options.outputPath);
      }

      const { stdout } = await execFileAsync(process.execPath, args, {
        cwd: options.cwd
      });

      return JSON.parse(stdout.trim());
    }
  };
}
