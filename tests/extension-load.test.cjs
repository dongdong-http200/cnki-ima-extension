const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('MV3 service worker loads all scripts in the declared order', () => {
  const root = path.resolve(__dirname, '..');
  const listeners = [];
  const context = vm.createContext({
    URL, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, crypto: globalThis.crypto,
    setTimeout, clearTimeout, btoa, atob,
    chrome: {
      tabs: { onRemoved: { addListener() {} } },
      runtime: { onMessage: { addListener: listener => listeners.push(listener) } },
    },
  });
  context.self = context;
  context.importScripts = (...scripts) => {
    for (const script of scripts) {
      vm.runInContext(fs.readFileSync(path.join(root, 'src', script), 'utf8'), context, { filename: script });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'background.js'), 'utf8'), context, { filename: 'background.js' });
  assert.equal(listeners.length, 1);
  assert.equal(typeof context.Cnki.findArticlePdf, 'function');
  assert.equal(typeof context.Pdf.downloadPdf, 'function');
  assert.equal(typeof context.CnkiRequest.withArticleHeaders, 'function');
  assert.equal(typeof context.Transfer.decodeChunk, 'function');
  assert.equal(typeof context.PageDownload.downloadFromTab, 'function');
  assert.equal(typeof context.WebpagePdf.printTab, 'function');
  assert.equal(typeof context.ReaderPdf.extractReaderArticle, 'function');
  assert.equal(typeof context.WebpageMetadata.readPageMetadata, 'function');
  assert.equal(typeof context.Ima.createImaClient, 'function');
  assert.equal(typeof context.Cos.uploadToCos, 'function');
});

test('all content scripts can be reinjected without redeclarations or duplicate listeners', () => {
  const makeEvent = () => ({ listeners: new Set(),
    addListener(listener) { this.listeners.add(listener); },
    removeListener(listener) { this.listeners.delete(listener); },
  });
  const runtime = { onMessage: makeEvent(), onConnect: makeEvent() };
  const context = vm.createContext({ URL, chrome: { runtime } });
  context.self = context;
  context.window = context;
  context.top = context;
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (let pass = 0; pass < 2; pass++) {
    for (const file of manifest.content_scripts[0].js) {
      vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
    }
  }
  assert.equal(runtime.onMessage.listeners.size, 1);
  assert.equal(runtime.onConnect.listeners.size, 1);
});
