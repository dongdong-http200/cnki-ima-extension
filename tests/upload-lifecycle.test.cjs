const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isCnkiArticleUrl } = require('../src/cnki.js');
const { normalizeWebUrl } = require('../src/ima.js');
const { normalizeLayout, fileSuffix } = require('../src/webpage-pdf.js');

const source = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');
const articleUrl = 'https://kns.cnki.net/kcms2/article/abstract?v=sample';
const pdfUrl = 'https://kns.cnki.net/download/pdf';
const start = {
  action: 'startUpload', tabId: 1, pageUrl: articleUrl, title: '例文', kind: 'pdf', knowledgeBaseId: 'library', folderId: 'folder',
  destination: '个人知识库 / 研究',
};

function makeWorker({ saved = {}, download = async () => new ArrayBuffer(1), print = async () => new ArrayBuffer(1),
  loadedArticleUrl = articleUrl, tabUrl = 'https://example.org/article' } = {}) {
  const ongoingTimers = new Set();
  const uploads = [];
  const imports = [];
  const calls = [];
  let listener;
  const chrome = {
    tabs: {
      onRemoved: { addListener() {} },
      get: async () => ({ url: tabUrl }),
      sendMessage: async () => ({ ok: true, article: { title: start.title, url: loadedArticleUrl, pdfUrl } }),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    runtime: {
      getPlatformInfo: async () => {},
      onMessage: { addListener(fn) { listener = fn; } },
    },
    storage: {
      local: { get: async () => ({ imaClientId: 'client', imaApiKey: 'key' }) },
      session: {
        get: async key => ({ [key]: saved[key] }),
        set: async data => { Object.assign(saved, data); },
        remove: async key => { delete saved[key]; },
      },
    },
  };
  vm.runInNewContext(source, {
    chrome, crypto: globalThis.crypto, importScripts() {}, Cnki: { isCnkiArticleUrl },
    Pdf: { downloadPdf: async () => { calls.push('download'); return download(); } },
    WebpagePdf: { normalizeLayout, fileSuffix, printTab: async (tabId, url, { layout }) => {
      calls.push(['print', tabId, url, layout]);
      return print();
    } },
    PageDownload: { downloadFromTab: async () => { calls.push('page fallback'); throw new Error('page fallback'); } },
    CnkiRequest: { withArticleHeaders: (_pdf, _page, work) => work() },
    Ima: { normalizeWebUrl, createImaClient: () => ({
      uploadPdf: async record => { uploads.push(record); record.onStatus('保存中'); },
      importWebLink: async record => { imports.push(record); },
    }) },
    Cos: { uploadToCos() {} },
    setInterval(callback) { ongoingTimers.add(callback); return callback; },
    clearInterval(callback) { ongoingTimers.delete(callback); },
  }, { filename: 'background.js' });
  const request = message => new Promise(resolve => listener(message, {}, resolve));
  const readStatus = async (tabId = 1) => (await request({ action: 'getUploadStatus', tabId })).data;
  return { request, readStatus, saved, uploads, imports, calls, ongoingTimers };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('acknowledges a confirmed location and completes independently of its popup', async () => {
  let finishDownload;
  const worker = makeWorker({ download: () => new Promise(resolve => { finishDownload = resolve; }) });
  const ack = await worker.request(start);
  assert.equal(ack.data.state, 'running');
  await settle();
  assert.equal((await worker.readStatus()).state, 'running');
  assert.equal((await worker.request(start)).data.id, ack.data.id);
  assert.equal(worker.ongoingTimers.size, 1);
  finishDownload(new ArrayBuffer(1));
  await settle();
  assert.equal(worker.ongoingTimers.size, 0);
  assert.equal(worker.saved['upload:1'].state, 'success');
  assert.equal(worker.uploads.length, 1);
  assert.equal(worker.uploads[0].folderId, 'folder');
  assert.equal(worker.uploads[0].knowledgeBaseId, 'library');
  assert.equal(await worker.readStatus(2), undefined);
  assert.equal(worker.saved['upload:1'].pageUrl, undefined);
});

test('a restarted service worker reports interrupted work and never replays writes', async () => {
  const worker = makeWorker({ saved: {
    'upload:1': { id: 'previous', revision: 2, tabId: 1, title: '例文', state: 'running', destination: start.destination },
    'upload:2': { id: 'other', revision: 3, tabId: 2, state: 'success' },
  } });
  const previous = await worker.readStatus();
  assert.equal(previous.state, 'interrupted');
  assert.match(previous.message, /先核对目标知识库/);
  assert.equal((await worker.readStatus(2)).state, 'success');
  assert.deepEqual(worker.calls, []);
  assert.deepEqual(worker.uploads, []);
});

test('a simultaneous request for the same article and destination cannot race the first upload', async () => {
  let finishDownload;
  const worker = makeWorker({ download: () => new Promise(resolve => { finishDownload = resolve; }) });
  await worker.request(start);
  await settle();
  await worker.request({ ...start, tabId: 2 });
  await settle();
  assert.match((await worker.readStatus(2)).message, /同一份 PDF 正在上传/);
  assert.equal((await worker.readStatus(1)).state, 'running');
  assert.deepEqual(worker.calls, ['download']);
  finishDownload(new ArrayBuffer(1));
  await settle();
  assert.equal(worker.uploads.length, 1);
});

test('CNKI verification pauses the job without trying a second route or writing to IMA', async () => {
  const worker = makeWorker({ download: async () => {
    throw Object.assign(new Error('知网要求安全验证'), { code: 'CNKI_VERIFICATION_REQUIRED' });
  } });
  await worker.request(start);
  await settle();
  const status = await worker.readStatus();
  assert.equal(status.state, 'verification');
  assert.equal(status.folderId, 'folder');
  assert.deepEqual(worker.calls, ['download']);
  assert.deepEqual(worker.uploads, []);
});

test('switching articles during submission cannot upload the new article to the old destination', async () => {
  const worker = makeWorker({ loadedArticleUrl: `${articleUrl}2` });
  await worker.request(start);
  await settle();
  assert.match((await worker.readStatus()).message, /页面已切换/);
  assert.deepEqual(worker.calls, []);
});

test('a confirmed link job imports only the active URL and preserves the chosen folder', async () => {
  const worker = makeWorker();
  const pageUrl = 'https://example.org/article';
  const ack = await worker.request({ ...start, kind: 'link', pageUrl });
  assert.equal(ack.data.state, 'running');
  await settle();
  assert.equal((await worker.readStatus()).state, 'success');
  assert.equal(worker.imports.length, 1);
  assert.equal(worker.imports[0].url, pageUrl);
  assert.equal(worker.imports[0].folderId, 'folder');
  assert.equal(worker.imports[0].knowledgeBaseId, 'library');
  assert.deepEqual(worker.calls, []);
  assert.deepEqual(worker.uploads, []);
});

test('a navigated tab or a non-web URL never submits a link job to IMA', async () => {
  const worker = makeWorker();
  const result = await worker.request({ ...start, kind: 'link', pageUrl: 'file:///private.pdf' });
  assert.equal(result.ok, false);
  await worker.request({ ...start, kind: 'link', pageUrl: 'https://example.org/previous' });
  await settle();
  assert.match((await worker.readStatus()).message, /页面已切换/);
  assert.deepEqual(worker.imports, []);
});

test('a normal page is rendered and uploaded as a PDF to the selected folder', async () => {
  const pageUrl = 'https://example.org/article#method';
  const buffer = new ArrayBuffer(42);
  const worker = makeWorker({ tabUrl: pageUrl, print: async () => buffer });
  await worker.request({ ...start, kind: 'pagePdf', pageUrl, title: '图文/网页', layout: 'reader' });
  await settle();
  assert.deepEqual(worker.calls, [['print', 1, pageUrl, 'reader']]);
  assert.deepEqual(worker.imports, []);
  assert.equal(worker.uploads[0].buffer, buffer);
  assert.equal(worker.uploads[0].fileName, '图文_网页（网页·正文）.pdf');
  assert.equal(worker.uploads[0].knowledgeBaseId, 'library');
  assert.equal(worker.uploads[0].folderId, 'folder');
  assert.match((await worker.readStatus()).message, /网页 PDF已保存/);
  assert.equal((await worker.readStatus()).layout, 'reader');
});

test('a print failure surfaces in the job and never submits a file or link to IMA', async () => {
  const worker = makeWorker({ print: async () => { throw new Error('网页转 PDF 超时'); } });
  await worker.request({ ...start, kind: 'pagePdf', pageUrl: 'https://example.org/article' });
  await settle();
  assert.equal((await worker.readStatus()).state, 'error');
  assert.equal((await worker.readStatus()).message, '网页转 PDF 超时');
  assert.deepEqual(worker.uploads, []);
  assert.deepEqual(worker.imports, []);
});
