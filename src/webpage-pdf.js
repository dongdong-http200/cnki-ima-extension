const printPdf = typeof module !== 'undefined' ? require('./pdf.js') : self.Pdf;
const printTransfer = typeof module !== 'undefined' ? require('./transfer.js') : self.Transfer;
const printIma = typeof module !== 'undefined' ? require('./ima.js') : self.Ima;
const printReader = typeof module !== 'undefined' ? require('./reader-pdf.js') : self.ReaderPdf;
const printMetadata = typeof module !== 'undefined' ? require('./webpage-metadata.js') : self.WebpageMetadata;
const A4 = { paperWidth: 8.27, paperHeight: 11.69 };
const pageMargin = 0.4;
const layoutSuffixes = {
  fit: '（网页·适宽）',
  reader: '（网页·正文）',
};

function normalizeLayout(layout) {
  return Object.hasOwn(layoutSuffixes, layout) ? layout : 'fit';
}

function fileSuffix(layout) {
  return layoutSuffixes[normalizeLayout(layout)];
}

async function printLayout(send) {
  const { cssContentSize, cssLayoutViewport } = await send('Page.getLayoutMetrics');
  const width = Math.max(cssContentSize?.width || 0, cssLayoutViewport?.clientWidth || 0);
  if (!Number.isFinite(width) || width <= 0) throw new Error('Edge 无法测量网页宽度，请刷新页面后重试。');

  // Add a few CSS pixels for the conversion to printed page units.
  const contentWidth = (Math.ceil(width) + 4) / 96;
  const desiredWidth = contentWidth + 2 * pageMargin;
  const paperWidth = Math.min(16.54, Math.max(A4.paperWidth, desiredWidth));
  const scale = Math.min(1, (paperWidth - 2 * pageMargin) / contentWidth);
  if (scale < 0.1) throw new Error('网页宽度超出浏览器打印范围，请缩小网页显示比例后重试。');
  return {
    paperWidth, paperHeight: Math.max(A4.paperHeight, paperWidth * 0.8), scale, preferCSSPageSize: false,
    marginBottom: pageMargin, marginLeft: pageMargin, marginRight: pageMargin,
  };
}

async function readPrintedPdf(send, stream) {
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { data, base64Encoded, eof } = await send('IO.read', { handle: stream, size: 512 * 1024 });
      if (typeof data !== 'string' || (!data && !eof)) throw new Error('浏览器返回的 PDF 数据不完整');
      const bytes = base64Encoded ? printTransfer.decodeChunk(data) : new TextEncoder().encode(data);
      length += bytes.byteLength;
      if (length > printPdf.MAX_PDF_BYTES) throw new Error('网页 PDF 超过 ima 200 MB 上限');
      chunks.push(bytes);
      if (eof) break;
    }
    return printPdf.validatePdf(printTransfer.joinChunks(chunks, length));
  } finally {
    await send('IO.close', { handle: stream }).catch(() => {});
  }
}

async function withPrintSession(tabId, browserDebugger, print) {
  const target = { tabId };
  try {
    await browserDebugger.attach(target, '1.3');
  } catch (error) {
    if (/already attached|another debugger/i.test(error.message)) {
      throw new Error('当前标签页正在被开发者工具或其他扩展调试。请关闭占用后重试。');
    }
    throw new Error(`Edge 无法连接该标签页进行转换。${error.message}`);
  }

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('网页转 PDF 超时。请等页面加载完成后重试。')), 120_000);
  });
  const send = (method, params = {}) => Promise.race([
    browserDebugger.sendCommand(target, method, params), deadline,
  ]);
  try {
    return await print(send);
  } finally {
    clearTimeout(timer);
    await browserDebugger.detach(target).catch(() => {});
  }
}

async function currentFrame(send, expectedUrl) {
  const { frameTree } = await send('Page.getFrameTree');
  const frame = frameTree?.frame;
  const url = frame && `${frame.url}${frame.urlFragment || ''}`;
  if (url !== expectedUrl && printIma.normalizeWebUrl(url) !== expectedUrl) {
    throw new Error('当前页面已切换，请重新打开扩展。');
  }
  if (frame.unreachableUrl) throw new Error('该网页未正常加载，请刷新后重试。');
  return frame;
}

async function printDocument(send, options, metadata) {
  const { stream } = await send('Page.printToPDF', {
    ...options, ...printMetadata.metadataHeader(metadata, options), printBackground: true, transferMode: 'ReturnAsStream',
  });
  if (!stream) throw new Error('Edge 未返回网页 PDF，请重试。');
  return readPrintedPdf(send, stream);
}

async function printReaderTab(tabId, pageUrl, browserDebugger) {
  const metadata = await printMetadata.readPageMetadata(tabId, pageUrl);
  const article = await printReader.extractReaderArticle(tabId, pageUrl);
  const renderTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  try {
    return await withPrintSession(renderTab.id, browserDebugger, async send => {
      const frame = await currentFrame(send, 'about:blank');
      await printReader.prepareReaderDocument(send, frame.id, article);
      const prepared = await currentFrame(send, 'about:blank');
      const buffer = await printDocument(send, {
        ...A4, preferCSSPageSize: false, marginBottom: 0.65, marginLeft: 0.72, marginRight: 0.72,
      }, metadata);
      const after = await currentFrame(send, 'about:blank');
      if (prepared.id !== after.id || prepared.loaderId !== after.loaderId) {
        throw new Error('正文打印页在转换过程中已切换，请重试。');
      }
      return buffer;
    });
  } finally {
    await chrome.tabs.remove(renderTab.id).catch(() => {});
  }
}

async function printTab(tabId, pageUrl, { layout, browserDebugger = chrome.debugger } = {}) {
  const expectedUrl = printIma.normalizeWebUrl(pageUrl);
  if (!expectedUrl) throw new Error('请打开要转为 PDF 的 HTTP 或 HTTPS 网页。');
  const selectedLayout = normalizeLayout(layout);
  if (selectedLayout === 'reader') return printReaderTab(tabId, expectedUrl, browserDebugger);

  return withPrintSession(tabId, browserDebugger, async send => {
    const before = await currentFrame(send, expectedUrl);
    if (before.mimeType === 'application/pdf') throw new Error('当前标签页已打开 PDF。请从网页详情页使用「整页转 PDF」。');
    const metadata = await printMetadata.readPageMetadata(tabId, expectedUrl);
    const buffer = await printDocument(send, await printLayout(send), metadata);
    const after = await currentFrame(send, expectedUrl);
    if (before.id !== after.id || before.loaderId !== after.loaderId) {
      throw new Error('页面在转换过程中已重新加载，请重新打开扩展。');
    }
    return buffer;
  });
}

const webpagePdfApi = { printTab, normalizeLayout, fileSuffix };
if (typeof module !== 'undefined') module.exports = webpagePdfApi;
if (typeof self !== 'undefined') self.WebpagePdf = webpagePdfApi;
