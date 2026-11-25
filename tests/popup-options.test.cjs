const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isCnkiArticleUrl } = require('../src/cnki.js');
const { normalizeWebUrl } = require('../src/ima.js');

function loadScript(file, globals) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  vm.runInNewContext(source, globals, { filename: file });
}

async function openPopup(overrides = {}, url = 'https://kns.cnki.net/kcms2/article/abstract?v=sample') {
  class PopupElement {
    constructor() {
      this.options = [];
      this.disabled = true;
      this.classList = { add() {} };
      this.listeners = {};
    }
    get selectedOptions() { return this.options.filter(option => option.value === this.value); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
    add(option) { this.options.push(option); }
  }
  const elements = Object.fromEntries(['article', 'pdfNote', 'library', 'folder', 'pdfLayout', 'upload', 'savePagePdf', 'saveLink', 'status', 'settings'].map(id => [id, new PopupElement()]));
  elements.pdfLayout.value = 'fit';
  const requests = [];
  let storageListener;
  const chrome = {
    tabs: { query: async () => [{ id: 1, url, title: '样本论文' }] },
    storage: { onChanged: { addListener(listener) { storageListener = listener; } } },
    runtime: {
      sendMessage: async message => {
        requests.push(message);
        return overrides[message.action] || { ok: true, data: {
          inspectArticle: { title: '样本论文', url },
          listLibraries: [{ id: 'library', name: '个人知识库' }],
          listFolders: [{ id: 'folder', path: '样本' }],
        }[message.action] };
      },
    },
  };
  const document = { getElementById: id => elements[id] };
  const Option = class { constructor(textContent, value) { Object.assign(this, { textContent, value }); } };
  loadScript('popup/popup.js', { document, chrome, Cnki: { isCnkiArticleUrl }, Ima: { normalizeWebUrl }, Option });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, requests, url, storageListener };
}

function previousJob(state, folderId = 'folder') {
  return { id: 'job', revision: 1, tabId: 1, title: '样本论文', kind: 'pdf', state, folderId,
    knowledgeBaseId: 'library', destination: '个人知识库 / 样本', message: '上次状态' };
}

test('keeps the CNKI and IMA errors visible when both services fail', async () => {
  const { elements } = await openPopup({
    inspectArticle: { ok: false, error: '扩展无法读取当前标签页' },
    listLibraries: { ok: false, error: 'ima 认证失败（HTTP 401）' },
  });
  assert.equal(elements.pdfNote.textContent, '扩展无法读取当前标签页');
  assert.equal(elements.status.textContent, 'ima 认证失败（HTTP 401）');
});

test('opening the popup sends nothing until the user chooses and confirms this destination', async () => {
  const { elements, requests, url } = await openPopup();
  assert.equal(elements.folder.value, '');
  assert.equal(elements.upload.disabled, true);
  await elements.upload.listeners.click();
  assert.equal(requests.some(request => request.action === 'startUpload'), false);
  elements.folder.value = 'folder';
  elements.folder.listeners.change();
  await elements.upload.listeners.click();
  const submitted = requests.filter(request => request.action === 'startUpload');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].folderId, 'folder');
  assert.equal(submitted[0].knowledgeBaseId, 'library');
  assert.equal(submitted[0].pageUrl, url);
  assert.equal(submitted[0].kind, 'pdf');
});

test('an ordinary webpage offers a file or a link after explicitly choosing a folder', async () => {
  const { elements, requests, url } = await openPopup({}, 'https://example.org/article#method');
  assert.equal(elements.upload.hidden, true);
  assert.equal(elements.saveLink.disabled, true);
  assert.equal(elements.savePagePdf.disabled, true);
  assert.equal(requests.some(request => request.action === 'inspectArticle'), false);
  await elements.savePagePdf.listeners.click();
  assert.equal(requests.some(request => request.action === 'startUpload'), false);
  elements.folder.value = 'folder';
  elements.folder.listeners.change();
  elements.pdfLayout.value = 'fit';
  await elements.savePagePdf.listeners.click();
  await elements.saveLink.listeners.click();
  const saves = requests.filter(request => request.action === 'startUpload');
  assert.deepEqual(saves.map(request => request.kind), ['pagePdf', 'link']);
  assert.equal(saves[0].layout, 'fit');
  assert.equal(saves[1].layout, undefined);
  for (const save of saves) {
    assert.equal(save.folderId, 'folder');
    assert.equal(save.knowledgeBaseId, 'library');
    assert.equal(save.pageUrl, url);
  }
});

test('reader layout submits only when selected and shows the matching PDF action', async () => {
  const { elements, requests } = await openPopup({}, 'https://example.org/story');
  assert.equal(elements.savePagePdf.textContent, '整页转 PDF');
  elements.pdfLayout.value = 'reader';
  elements.pdfLayout.listeners.change();
  assert.equal(elements.savePagePdf.textContent, '正文转 PDF');
  elements.folder.value = 'folder';
  elements.folder.listeners.change();
  await elements.savePagePdf.listeners.click();
  assert.equal(requests.find(request => request.action === 'startUpload').layout, 'reader');
});

test('a CNKI detail page can be saved as a link when no PDF entry point is available', async () => {
  const { elements, requests } = await openPopup({ inspectArticle: { ok: false, error: '未找到 PDF 下载入口' } });
  assert.equal(elements.upload.hidden, true);
  assert.equal(elements.pdfNote.hidden, false);
  elements.folder.value = '/';
  elements.folder.listeners.change();
  await elements.saveLink.listeners.click();
  const job = requests.find(request => request.action === 'startUpload');
  assert.equal(job.kind, 'link');
  assert.equal(job.folderId, '');
});

test('reopens with the running job, then shows its terminal state from the worker', async () => {
  const { elements, requests, storageListener } = await openPopup({
    getUploadStatus: { ok: true, data: previousJob('running') },
  });
  assert.equal(elements.upload.disabled, true);
  assert.match(elements.status.textContent, /上次状态/);
  storageListener({ other: { newValue: { ...previousJob('success'), tabId: 2, message: '另一标签' } } }, 'session');
  assert.match(elements.status.textContent, /上次状态/);
  storageListener({ current: { newValue: { ...previousJob('success'), revision: 2, message: '已入库' } } }, 'session');
  assert.equal(elements.status.textContent, '已入库');
  assert.equal(requests.some(request => request.action === 'startUpload'), false);
});

test('an interrupted upload to a deleted folder asks for an explicit new location', async () => {
  const { elements, requests } = await openPopup({
    getUploadStatus: { ok: true, data: previousJob('interrupted', 'deleted') },
  });
  assert.equal(elements.folder.value, '');
  assert.equal(elements.upload.disabled, true);
  assert.equal(requests.some(request => request.action === 'startUpload'), false);
});

test('tests new credentials before replacing the existing IMA settings', async () => {
  const values = { imaClientId: 'saved-id', imaApiKey: 'saved-key' };
  const calls = [];
  let save;
  let rejectCredentials = true;
  const elements = { clientId: {}, apiKey: {}, result: {}, save: { addEventListener(_type, listener) { save = listener; } } };
  const chrome = { storage: { local: {
    get: async () => values,
    set: async record => { calls.push('save'); Object.assign(values, record); },
  } } };
  const Ima = { createImaClient: () => ({ listLibraries: async () => {
    calls.push('test');
    if (rejectCredentials) throw new Error('ima 认证失败（HTTP 401）');
    return [{ name: '文献' }];
  } }) };
  loadScript('options/options.js', { document: { getElementById: id => elements[id] }, chrome, Ima });
  await new Promise(resolve => setImmediate(resolve));
  elements.clientId.value = 'new-id';
  elements.apiKey.value = 'new-key';
  await save();
  assert.deepEqual(calls, ['test']);
  assert.equal(values.imaApiKey, 'saved-key');

  rejectCredentials = false;
  await save();
  assert.deepEqual(calls, ['test', 'test', 'save']);
  assert.equal(values.imaApiKey, 'new-key');
  assert.match(elements.result.textContent, /凭证已保存/);
});
