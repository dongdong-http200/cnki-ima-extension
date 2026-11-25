const articleEl = document.getElementById('article');
const pdfNoteEl = document.getElementById('pdfNote');
const libraryEl = document.getElementById('library');
const folderEl = document.getElementById('folder');
const pdfLayoutEl = document.getElementById('pdfLayout');
const uploadEl = document.getElementById('upload');
const savePagePdfEl = document.getElementById('savePagePdf');
const saveLinkEl = document.getElementById('saveLink');
const statusEl = document.getElementById('status');
const rootFolder = '/';
let tabId;
let page;
let article;
let currentJob;
let librariesReady = false;
let foldersReady = false;
let submitting = false;
let folderRequest = 0;

function status(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function updateControls() {
  const locked = submitting || currentJob?.state === 'running';
  const canSave = !locked && foldersReady && !!folderEl.value;
  libraryEl.disabled = locked || !librariesReady;
  folderEl.disabled = locked || !foldersReady;
  pdfLayoutEl.disabled = locked || !page;
  uploadEl.hidden = !article;
  uploadEl.disabled = !canSave || !article;
  savePagePdfEl.textContent = pdfLayoutEl.value === 'reader' ? '正文转 PDF' : '整页转 PDF';
  savePagePdfEl.disabled = !canSave || !page;
  saveLinkEl.disabled = !canSave || !page;
}

async function call(action, fields = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...fields });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有响应，请重新打开扩展。');
  return result.data;
}

function showJob(job) {
  const source = job?.kind === 'pdf' ? article : page;
  if (!source || job?.tabId !== tabId || job.title !== source.title) return;
  if (job.id === currentJob?.id && job.revision < currentJob.revision) return;
  currentJob = job;
  const kind = job.state === 'running' ? '' : job.state === 'success' ? 'success' : 'error';
  const showLocation = job.state !== 'success';
  status(showLocation ? `${job.destination} · ${job.message}` : job.message, kind);
  updateControls();
}

async function loadFolders(preferredFolder) {
  const requestId = ++folderRequest;
  const knowledgeBaseId = libraryEl.value;
  foldersReady = false;
  updateControls();
  folderEl.replaceChildren(new Option(knowledgeBaseId ? '正在加载文件夹…' : '请先选择知识库', ''));
  if (!knowledgeBaseId) return;
  try {
    const folders = await call('listFolders', { knowledgeBaseId });
    if (requestId !== folderRequest) return;
    folderEl.replaceChildren(new Option('请选择存放位置', ''), new Option('根目录', rootFolder));
    for (const folder of folders) folderEl.add(new Option(folder.path, folder.id));
    if (preferredFolder === '' || folders.some(folder => folder.id === preferredFolder)) {
      folderEl.value = preferredFolder || rootFolder;
    }
    foldersReady = true;
  } catch (error) {
    if (requestId !== folderRequest) return;
    folderEl.replaceChildren(new Option('文件夹不可用', ''));
    status(error.message, 'error');
  }
  updateControls();
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = Ima.normalizeWebUrl(tab?.url);
    if (!tab?.id || !url) throw new Error('请先打开要保存的网页。');
    tabId = tab.id;
    page = { url, title: tab.title?.trim() || new URL(url).hostname };
    articleEl.textContent = page.title;
    updateControls();
  } catch (error) {
    articleEl.textContent = error.message;
    articleEl.classList.add('error');
    return;
  }
  if (Cnki.isCnkiArticleUrl(page.url)) {
    try {
      article = await call('inspectArticle', { tabId });
      articleEl.textContent = article.title;
    } catch (error) {
      pdfNoteEl.textContent = error.message;
      pdfNoteEl.hidden = false;
    }
  }
  try { showJob(await call('getUploadStatus', { tabId })); }
  catch (error) { status(error.message, 'error'); }
  try {
    const libraries = await call('listLibraries');
    if (!libraries.length) throw new Error('ima 中没有可写入的知识库');
    libraryEl.replaceChildren(new Option('请选择知识库', ''));
    for (const library of libraries) libraryEl.add(new Option(library.name, library.id));
    librariesReady = true;
    const retry = currentJob && currentJob.state !== 'success' && libraries.some(library => library.id === currentJob.knowledgeBaseId);
    if (retry) libraryEl.value = currentJob.knowledgeBaseId;
    else if (libraries.length === 1) libraryEl.value = libraries[0].id;
    if (retry && currentJob.layout === 'reader') pdfLayoutEl.value = 'reader';
    await loadFolders(retry ? currentJob.folderId : undefined);
  } catch (error) {
    libraryEl.replaceChildren(new Option('知识库不可用', ''));
    status(error.message, 'error');
    updateControls();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const change of Object.values(changes)) showJob(change.newValue);
});

async function savePage(kind) {
  const source = kind === 'pdf' ? article : page;
  const button = kind === 'pdf' ? uploadEl : kind === 'pagePdf' ? savePagePdfEl : saveLinkEl;
  if (!source || button.disabled) return;
  const destination = `${libraryEl.selectedOptions[0].textContent} / ${folderEl.selectedOptions[0].textContent}`;
  const layout = kind === 'pagePdf' ? pdfLayoutEl.value : undefined;
  submitting = true;
  updateControls();
  try {
    showJob(await call('startUpload', {
      tabId, pageUrl: source.url, title: source.title, destination, kind,
      knowledgeBaseId: libraryEl.value, folderId: folderEl.value === rootFolder ? '' : folderEl.value,
      ...(layout ? { layout } : {}),
    }));
  } catch (error) {
    status(error.message, 'error');
  } finally {
    submitting = false;
    updateControls();
  }
}

libraryEl.addEventListener('change', () => loadFolders());
folderEl.addEventListener('change', updateControls);
uploadEl.addEventListener('click', () => savePage('pdf'));
pdfLayoutEl.addEventListener('change', updateControls);
savePagePdfEl.addEventListener('click', () => savePage('pagePdf'));
saveLinkEl.addEventListener('click', () => savePage('link'));
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
init();
