var contentTransfer = typeof module !== 'undefined' ? require('./transfer.js') : self.Transfer;
var contentCnki = typeof module !== 'undefined' ? require('./cnki.js') : self.Cnki;
var MAX_PAGE_PDF_BYTES = 200 * 1024 * 1024;

async function streamPdf(value, pageUrl, port, fetchImpl = fetch, disconnectSignal) {
  const target = new URL(value);
  const page = new URL(pageUrl);
  if (target.protocol !== 'https:' || page.protocol !== 'https:' || !contentCnki.isCnkiHost(target.hostname) || !contentCnki.isCnkiHost(page.hostname)) {
    throw new Error('PDF 入口不在知网 HTTPS 站点内');
  }
  if (target.searchParams.get('scope')?.toLowerCase() === 'trial') throw new Error('知网只提供试读');
  const deadline = AbortSignal.timeout(240_000);
  const signal = disconnectSignal ? AbortSignal.any([deadline, disconnectSignal]) : deadline;
  const response = await fetchImpl(target.href, { credentials: 'include', redirect: 'follow', cache: 'no-store', signal });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !contentCnki.isCnkiHost(finalUrl.hostname) || finalUrl.searchParams.get('scope')?.toLowerCase() === 'trial') {
    throw new Error('知网下载跳转至其他站点或试读页');
  }
  contentCnki.checkDownloadVerification(finalUrl);
  if (!response.ok) throw new Error(`知网下载失败：HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_PDF_BYTES) throw new Error('PDF 超过 ima 200 MB 上限');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PAGE_PDF_BYTES) throw new Error('PDF 超过 ima 200 MB 上限');
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 5));
  const tail = new TextDecoder('ascii').decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (head !== '%PDF-') throw new Error('知网页面请求返回的不是 PDF');
  if (!tail.includes('%%EOF')) throw new Error('知网返回的 PDF 不完整');
  port.postMessage({ type: 'begin', length: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    port.postMessage({ type: 'chunk', data: contentTransfer.encodeChunk(bytes.subarray(offset, offset + 32768)) });
  }
  port.postMessage({ type: 'end' });
}

var pageContentApi = { streamPdf };
if (typeof module !== 'undefined') module.exports = pageContentApi;
if (typeof self !== 'undefined') self.PageContent = pageContentApi;
