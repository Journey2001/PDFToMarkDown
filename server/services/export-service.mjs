import { exportPdf } from '../../scripts/export-awesome-gpt-image-pdf.mjs';

export function createExportService() {
  return {
    async run(options = {}) {
      return exportPdf({
        lang: options.lang ?? 'zh-CN',
        inputPath: options.markdownPath,
        appendLicenseNote: options.appendLicenseNote ?? false,
        licenseNote: typeof options.licenseNote === 'string' ? options.licenseNote : '',
        watermarkText: typeof options.watermarkText === 'string' ? options.watermarkText : '',
        markdownOnly: false
      });
    }
  };
}
