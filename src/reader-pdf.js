const readerIma = typeof module !== 'undefined' ? require('./ima.js') : self.Ima;
const readerStyles = `
  html { color: #17202a; background: #fff; }
  body { margin: 0; font: 11pt/1.65 system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; overflow-wrap: anywhere; }
  article > header { margin-bottom: 18pt; padding-bottom: 8pt; border-bottom: 1px solid #dde2e7; }
  article > header h1 { margin: 0 0 6pt; font-size: 23pt; line-height: 1.24; }
  figcaption, caption { color: #4e5e70; font-size: 9pt; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; break-after: avoid; }
  p { margin: 0 0 8pt; orphans: 3; widows: 3; }
  a { color: #1e4f7f; text-underline-offset: 2px; }
  img { display: block; max-width: 100%; max-height: 185mm; width: auto; height: auto; object-fit: contain; break-inside: avoid; }
  figure { margin: 12pt 0; break-inside: avoid; }
  blockquote { margin: 10pt 0; padding-inline-start: 12pt; border-inline-start: 2px solid #c8d5e1; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f3f5f7; padding: 8pt; }
  table { width: 100%; margin: 10pt 0; border-collapse: collapse; font-size: 9pt; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid #c8d5e1; padding: 4pt; vertical-align: top; }
  th { background: #f3f5f7; }
`;

async function extractReaderArticle(tabId, pageUrl, scripting = chrome.scripting) {
  let injection;
  try {
    [injection] = await scripting.executeScript({
      target: { tabId },
      files: ['vendor/readability/Readability.js', 'src/reader-content.js'],
      world: 'ISOLATED',
    });
  } catch {
    throw new Error('Edge 无法读取当前网页正文。请刷新后重试，或改用「自动适宽」。');
  }
  const result = injection?.result;
  if (!result || readerIma.normalizeWebUrl(result.url) !== pageUrl) {
    throw new Error('当前页面已切换或无法读取，请重新打开扩展。');
  }
  if (!result.html) throw new Error('未识别到可排版的正文，请改用「自动适宽」保存整页。');
  return result.html;
}

async function waitForReaderAssets() {
  let timeout;
  const images = [...document.images];
  try {
    await Promise.race([
      Promise.allSettled([document.fonts.ready, ...images.map(image => image.decode())]),
      new Promise(resolve => { timeout = setTimeout(resolve, 12000); }),
    ]);
    return images.filter(image => !image.complete || !image.naturalWidth).length;
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareReaderDocument(send, frameId, article) {
  // Only the allowlisted DOM built by reader-content.js enters the isolated print tab.
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>网页正文</title><style>${readerStyles}</style></head><body>${article}</body></html>`;
  await send('Page.setDocumentContent', { frameId, html });
  const status = await send('Runtime.evaluate', {
    expression: `(${waitForReaderAssets.toString()})()`, awaitPromise: true, returnByValue: true,
  });
  const missingImages = status.result?.value;
  if (status.exceptionDetails || !Number.isInteger(missingImages)) {
    throw new Error('未能确认正文排版已加载，请重试。');
  }
  if (missingImages) throw new Error(`正文中有 ${missingImages} 张图片未加载。请重试，或用「自动适宽」保留原网页。`);
}

const readerPdfApi = { extractReaderArticle, prepareReaderDocument };
if (typeof module !== 'undefined') module.exports = readerPdfApi;
if (typeof self !== 'undefined') self.ReaderPdf = readerPdfApi;
