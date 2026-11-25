importScripts('cnki.js', 'pdf.js', 'cnki-request.js', 'transfer.js', 'page-download.js', 'ima.js', 'cos.js', 'reader-pdf.js', 'webpage-metadata.js', 'webpage-pdf.js');

const activeUploads = new Map();
const activeFiles = new Set();
const uploadKey = tabId => `upload:${tabId}`;

async function credentials() {
  const saved = await chrome.storage.local.get(['imaClientId', 'imaApiKey']);
  const clientId = saved.imaClientId?.trim();
  const apiKey = saved.imaApiKey?.trim();
  if (!clientId || !apiKey) throw new Error('请先在扩展设置中配置 ima Client ID 和 API Key');
  return { clientId, apiKey };
}

async function inspectArticle(tabId) {
  let result;
  try { result = await chrome.tabs.sendMessage(tabId, { action: 'inspectArticle' }); }
  catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/cnki.js', 'src/transfer.js', 'src/page-content.js', 'src/content.js'] });
      result = await chrome.tabs.sendMessage(tabId, { action: 'inspectArticle' });
    } catch {
      throw new Error('扩展无法读取当前标签页。请确认知网论文详情页已正常打开，再刷新页面并重试。');
    }
  }
  if (!result?.ok) throw new Error(result?.error || '无法识别知网文章');
  return result.article;
}

function fileNameFor(title, layout) {
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 160);
  return layout ? `${safe || '网页'}${WebpagePdf.fileSuffix(layout)}.pdf` : `${safe || '知网论文'}.pdf`;
}

function showBadge(tabId, state) {
  const [text, color] = state === 'running' ? ['…', '#1765ad'] :
    state === 'success' ? ['✓', '#188038'] : ['!', '#c5221f'];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function updateUpload(job, state, message) {
  const record = { ...job.record, state, message, revision: job.record.revision + 1 };
  job.record = record;
  const write = job.written.then(async () => {
    if (job.closed) return;
    await chrome.storage.session.set({ [uploadKey(record.tabId)]: record });
    if (!job.closed) showBadge(record.tabId, state);
  });
  job.written = write.catch(() => {});
  return write;
}

async function getUploadStatus(tabId) {
  const key = uploadKey(tabId);
  const { [key]: saved } = await chrome.storage.session.get(key);
  const active = activeUploads.get(tabId);
  if (active) return active.record;
  if (saved?.state !== 'running') return saved;
  const interrupted = {
    ...saved,
    state: 'interrupted',
    message: '上次保存中断。请先核对目标知识库是否已有该条目，然后选择重试。',
    revision: saved.revision + 1,
  };
  await chrome.storage.session.set({ [key]: interrupted });
  showBadge(tabId, 'interrupted');
  return interrupted;
}

async function downloadArticle(job, article) {
  try {
    return await CnkiRequest.withArticleHeaders(article.pdfUrl, article.url, () => Pdf.downloadPdf(article.pdfUrl));
  } catch (backgroundError) {
    if (backgroundError.code === 'CNKI_VERIFICATION_REQUIRED') throw backgroundError;
    await updateUpload(job, 'running', '正在通过知网页面读取 PDF…').catch(() => {});
    try { return await PageDownload.downloadFromTab(job.record.tabId, article.pdfUrl); }
    catch (pageError) {
      if (pageError.code === 'CNKI_VERIFICATION_REQUIRED') throw pageError;
      const backgroundMessage = backgroundError.name === 'TimeoutError' ? '知网后台请求超时' : backgroundError.message;
      throw new Error(`知网 PDF 获取失败。后台请求：${backgroundMessage}。页面请求：${pageError.message}`);
    }
  }
}

async function runUpload(job) {
  const { tabId, knowledgeBaseId, folderId, destination, kind, layout } = job.record;
  const linkJob = kind === 'link';
  const webpageJob = kind === 'pagePdf';
  // Keep the worker active only while it processes a user-confirmed save.
  const heartbeat = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  let fileLock;
  try {
    const source = kind === 'pdf' ? await inspectArticle(tabId) : await chrome.tabs.get(tabId);
    const currentUrl = kind === 'pdf' ? source.url : Ima.normalizeWebUrl(source.url);
    if (currentUrl !== job.pageUrl) throw new Error('当前页面已切换，请重新打开扩展。');
    const item = linkJob ? currentUrl : fileNameFor(webpageJob ? job.record.title : source.title, layout);
    const key = JSON.stringify([knowledgeBaseId, folderId, linkJob, item]);
    if (activeFiles.has(key)) {
      throw new Error(linkJob ? '同一链接正在导入该位置，请等待完成。' : '同一份 PDF 正在上传到该位置，请等待完成。');
    }
    activeFiles.add(key);
    fileLock = key;
    const client = Ima.createImaClient(await credentials());
    if (linkJob) {
      await updateUpload(job, 'running', '正在导入网页链接…');
      await client.importWebLink({ url: currentUrl, knowledgeBaseId, folderId });
    } else {
      const progress = layout === 'reader' ? '正在提取网页正文并生成 PDF…' :
        webpageJob ? '正在将网页转为 PDF…' : '正在获取知网 PDF…';
      await updateUpload(job, 'running', progress);
      const buffer = webpageJob ? await WebpagePdf.printTab(tabId, currentUrl, { layout }) : await downloadArticle(job, source);
      if (webpageJob && job.closed) return;
      await client.uploadPdf({
        buffer, fileName: item, knowledgeBaseId, folderId,
        cosUpload: Cos.uploadToCos,
        onStatus: status => updateUpload(job, 'running', status),
      });
    }
    const label = linkJob ? '网页链接' : webpageJob ? '网页 PDF' : 'PDF';
    await updateUpload(job, 'success', `${label}已保存到「${destination}」`).catch(() => {});
  } catch (error) {
    const state = error.code === 'CNKI_VERIFICATION_REQUIRED' ? 'verification' : 'error';
    await updateUpload(job, state, error.message).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    if (fileLock) activeFiles.delete(fileLock);
    activeUploads.delete(tabId);
  }
}

async function startUpload(message) {
  const { tabId, pageUrl, title, knowledgeBaseId, folderId, destination, kind } = message;
  if (!Number.isInteger(tabId) || typeof title !== 'string' || !knowledgeBaseId ||
      typeof folderId !== 'string' || typeof destination !== 'string') {
    throw new Error('请选择目标知识库及存放位置。');
  }
  const sourceUrl = kind === 'link' || kind === 'pagePdf' ? Ima.normalizeWebUrl(pageUrl) :
    kind === 'pdf' && Cnki.isCnkiArticleUrl(pageUrl) ? pageUrl : null;
  if (!sourceUrl) {
    throw new Error('请打开要保存的网页或知网论文详情页。');
  }
  const layout = kind === 'pagePdf' ? WebpagePdf.normalizeLayout(message.layout) : undefined;
  const active = activeUploads.get(tabId);
  if (active) {
    if (active.pageUrl !== sourceUrl || active.record.kind !== kind || active.record.layout !== layout) {
      throw new Error('此标签页已有保存任务，请等待完成。');
    }
    return active.record;
  }
  const job = {
    record: { id: crypto.randomUUID(), revision: 0, tabId, title, knowledgeBaseId, folderId, destination, kind,
      ...(layout ? { layout } : {}) },
    pageUrl: sourceUrl,
    written: Promise.resolve(),
  };
  activeUploads.set(tabId, job);
  try {
    await updateUpload(job, 'running', '正在准备保存…');
  } catch {
    activeUploads.delete(tabId);
    throw new Error('扩展无法保存任务状态，请重新打开扩展后重试。');
  }
  void runUpload(job);
  return job.record;
}

chrome.tabs.onRemoved.addListener(tabId => {
  const active = activeUploads.get(tabId);
  if (active) active.closed = true;
  void (active?.written || Promise.resolve()).then(() => chrome.storage.session.remove(uploadKey(tabId))).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'inspectArticle': return inspectArticle(message.tabId);
      case 'listLibraries': return Ima.createImaClient(await credentials()).listLibraries();
      case 'listFolders': return Ima.createImaClient(await credentials()).listFolders(message.knowledgeBaseId);
      case 'getUploadStatus': return getUploadStatus(message.tabId);
      case 'startUpload': return startUpload(message);
      default: throw new Error('未知操作');
    }
  })().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
