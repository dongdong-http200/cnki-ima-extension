const test = require('node:test');
const assert = require('node:assert/strict');
const { printTab, normalizeLayout } = require('../src/webpage-pdf.js');

const pageUrl = 'https://example.org/read#figures';
const frame = { id: 'main', loaderId: 'initial', url: 'https://example.org/read', urlFragment: '#figures', mimeType: 'text/html' };

function makeDebugger({ frames = [frame, frame], chunks = ['%PDF-1.7\n', '%%EOF\n'], width = 1417, missingImages = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async attach(target, version) { calls.push(['attach', target, version]); },
    async detach(target) { calls.push(['detach', target]); },
    async sendCommand(target, method, params) {
      calls.push([method, target, params]);
      switch (method) {
        case 'Page.getFrameTree': return { frameTree: { frame: frames.shift() } };
        case 'Page.getLayoutMetrics': return { cssContentSize: { width }, cssLayoutViewport: { clientWidth: 1048 } };
        case 'Page.setDocumentContent': return {};
        case 'Runtime.evaluate': return { result: { value: missingImages } };
        case 'Page.printToPDF': return { stream: 'print-result' };
        case 'IO.read': return { data: Buffer.from(chunks.shift()).toString('base64'), base64Encoded: true, eof: !chunks.length };
        case 'IO.close': return {};
        default: assert.fail(`Unexpected debugger command: ${method}`);
      }
    },
  };
}

test('prints the entire current page and closes the PDF stream and debugger', async () => {
  const browserDebugger = makeDebugger();
  const buffer = await printTab(17, pageUrl, { browserDebugger });
  assert.equal(new TextDecoder().decode(buffer), '%PDF-1.7\n%%EOF\n');
  assert.deepEqual(browserDebugger.calls.map(([method]) => method), [
    'attach', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.printToPDF', 'IO.read', 'IO.read', 'IO.close', 'Page.getFrameTree', 'detach',
  ]);
  assert.ok(browserDebugger.calls.every(([, target]) => target.tabId === 17));
  const params = browserDebugger.calls.find(([method]) => method === 'Page.printToPDF')[2];
  assert.equal(params.printBackground, true);
  assert.equal(params.pageRanges, undefined);
  assert.equal(params.transferMode, 'ReturnAsStream');
  assert.equal(params.preferCSSPageSize, false);
  assert.ok((params.paperWidth - params.marginLeft - params.marginRight) * 96 > 1417);
  assert.equal(params.scale, 1);
  assert.match(params.headerTemplate, /网站名称.*example\.org/);
  assert.match(params.headerTemplate, /来源网址.*read#figures/);
});

test('uses automatic width for captures with a removed layout preference', () => {
  assert.equal(normalizeLayout('fit'), 'fit');
  assert.equal(normalizeLayout('reader'), 'reader');
  assert.equal(normalizeLayout('landscape'), 'fit');
  assert.equal(normalizeLayout('original'), 'fit');
});

test('does not print a different or restricted page', async () => {
  const browserDebugger = makeDebugger({ frames: [{ ...frame, url: 'https://example.org/other' }] });
  await assert.rejects(printTab(17, pageUrl, { browserDebugger }), /页面已切换/);
  assert.deepEqual(browserDebugger.calls.map(([method]) => method), ['attach', 'Page.getFrameTree', 'detach']);
  const restricted = makeDebugger();
  await assert.rejects(printTab(17, 'edge://extensions/', { browserDebugger: restricted }), /HTTP 或 HTTPS/);
  assert.deepEqual(restricted.calls, []);
});

test('rejects a PDF if the tab reloaded at the same URL during printing', async () => {
  const browserDebugger = makeDebugger({ frames: [frame, { ...frame, loaderId: 'replacement' }] });
  await assert.rejects(printTab(17, pageUrl, { browserDebugger }), /重新加载/);
  assert.equal(browserDebugger.calls.at(-1)[0], 'detach');
});

test('rejects truncated output and releases resources', async () => {
  const browserDebugger = makeDebugger({ chunks: ['%PDF-1.7\n'] });
  await assert.rejects(printTab(17, pageUrl, { browserDebugger }), /不完整/);
  assert.deepEqual(browserDebugger.calls.slice(-2).map(([method]) => method), ['IO.close', 'detach']);
});

function readerHarness(t, { missingImages = 0, result = { url: pageUrl, html: '<article><h1>Fixture</h1><p>Body.</p></article>' } } = {}) {
  const blank = { id: 'reader-frame', loaderId: 'initial', url: 'about:blank', mimeType: 'text/html' };
  const browserDebugger = makeDebugger({ frames: [blank, blank, blank], missingImages });
  const tabs = [];
  globalThis.chrome = {
    scripting: { executeScript: async ({ target, files, func, world }) => {
      assert.equal(target.tabId, 17);
      assert.equal(world, 'ISOLATED');
      if (func) return [{ result: { url: pageUrl, site: '研究资讯', author: '张三', published: '2026-11-25' } }];
      assert.deepEqual(files, ['vendor/readability/Readability.js', 'src/reader-content.js']);
      return [{ result }];
    } },
    tabs: {
      async create(details) { tabs.push(['create', details]); return { id: 31 }; },
      async remove(id) { tabs.push(['remove', id]); },
    },
  };
  t.after(() => { delete globalThis.chrome; });
  return { browserDebugger, tabs };
}

test('reader layout prints the extracted article in an isolated tab and closes it', async t => {
  const { browserDebugger, tabs } = readerHarness(t);
  const buffer = await printTab(17, pageUrl, { browserDebugger, layout: 'reader' });
  assert.equal(new TextDecoder().decode(buffer), '%PDF-1.7\n%%EOF\n');
  assert.deepEqual(tabs, [['create', { url: 'about:blank', active: false }], ['remove', 31]]);
  assert.ok(browserDebugger.calls.every(([, target]) => target.tabId === 31));
  const [, , document] = browserDebugger.calls.find(([method]) => method === 'Page.setDocumentContent');
  assert.match(document.html, /default-src 'none'/);
  assert.match(document.html, /<h1>Fixture<\/h1>/);
  const [, , options] = browserDebugger.calls.find(([method]) => method === 'Page.printToPDF');
  assert.deepEqual([options.paperWidth, options.paperHeight], [8.27, 11.69]);
  assert.match(options.headerTemplate, /网站名称.*研究资讯/);
  assert.match(options.headerTemplate, /作者 \/ 发言人.*张三/);
  assert.match(options.headerTemplate, /公布时间.*2026-11-25/);
  assert.match(options.headerTemplate, /来源网址.*read#figures/);
  assert.equal(browserDebugger.calls.at(-1)[0], 'detach');
});

test('unreadable pages do not open a print tab, and reader asset failures close it', async t => {
  await t.test('no article', async testCase => {
    const { browserDebugger, tabs } = readerHarness(testCase, { result: { url: pageUrl } });
    await assert.rejects(printTab(17, pageUrl, { browserDebugger, layout: 'reader' }), /未识别到.*正文/);
    assert.equal(tabs.length, 0);
  });
  await t.test('missing image', async testCase => {
    const { browserDebugger, tabs } = readerHarness(testCase, { missingImages: 1 });
    await assert.rejects(printTab(17, pageUrl, { browserDebugger, layout: 'reader' }), /1 张图片未加载/);
    assert.deepEqual(tabs.at(-1), ['remove', 31]);
    assert.equal(browserDebugger.calls.at(-1)[0], 'detach');
    assert.equal(browserDebugger.calls.some(([method]) => method === 'Page.printToPDF'), false);
  });
});
