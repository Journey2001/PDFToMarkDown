import {
  fetchMarkdownBundle,
  materializeMarkdownBundle
} from '../../scripts/export-awesome-gpt-image-pdf.mjs';

export function createDownloadService() {
  return {
    async run(options = {}) {
      const bundle = await fetchMarkdownBundle({
        lang: options.lang ?? 'zh-CN',
        outputRoot: options.outputRoot,
        githubUrl: options.githubUrl,
        stripSources: options.stripSources ?? false,
        appendLicenseNote: false,
        markdownOnly: true
      });

      return materializeMarkdownBundle(bundle);
    }
  };
}
