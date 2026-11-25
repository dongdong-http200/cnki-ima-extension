(() => {
  if (window !== window.top) return;
  const previous = window.__cnkiImaListeners;
  if (previous) {
    try {
      chrome.runtime.onMessage.removeListener(previous.inspect);
      chrome.runtime.onConnect.removeListener(previous.connect);
    } catch { /* A reloaded extension may have invalidated the old listeners. */ }
  }

  function inspect() {
    const url = location.href;
    if (!Cnki.isCnkiArticleUrl(url)) throw new Error('请先打开知网单篇文章详情页');
    const links = Array.from(document.querySelectorAll('a[href]'), a => ({
      id: a.id,
      className: typeof a.className === 'string' ? a.className : '',
      text: (a.innerText || a.textContent || '').trim(),
      href: a.getAttribute('href'),
    }));
    const pdfUrl = Cnki.findArticlePdf(url, links);
    if (!pdfUrl) throw new Error('这篇文章未找到可读取的 PDF 下载入口');
    const metaTitle = document.querySelector('meta[name="citation_title"]')?.content;
    const heading = document.querySelector('h1')?.textContent?.trim();
    const title = Cnki.pickArticleTitle(metaTitle, document.title, heading);
    return { url, pdfUrl, title };
  }

  function inspectMessage(message, _sender, respond) {
    if (message.action !== 'inspectArticle') return;
    try { respond({ ok: true, article: inspect() }); }
    catch (error) { respond({ ok: false, error: error.message }); }
  }

  function connectPdf(port) {
    if (port.name !== 'cnki-ima-pdf') return;
    const connection = new AbortController();
    port.onDisconnect.addListener(() => connection.abort());
    port.onMessage.addListener(async message => {
      try { await PageContent.streamPdf(message.url, location.href, port, fetch, connection.signal); }
      catch (error) {
        const description = error.name === 'TimeoutError' ? '知网页面请求超时。' : error.message;
        try { port.postMessage({ type: 'error', error: description, code: error.code }); } catch { /* Port closed. */ }
      }
    });
  }
  chrome.runtime.onMessage.addListener(inspectMessage);
  chrome.runtime.onConnect.addListener(connectPdf);
  window.__cnkiImaListeners = { inspect: inspectMessage, connect: connectPdf };
})();
