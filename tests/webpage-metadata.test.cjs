const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPageMetadata, metadataHeader } = require('../src/webpage-metadata.js');

const url = 'https://example.org/story?id=20&source=preview';

function inspectedDocument({ meta = [], schema = [], elements = {}, title = '' } = {}) {
  return {
    title,
    querySelector(selector) { return elements[selector] ?? null; },
    querySelectorAll(selector) {
      if (selector === 'meta[content]') return meta.map(([name, content]) => ({ content,
        getAttribute: key => key === 'name' ? name : null,
      }));
      if (selector === 'script[type="application/ld+json"]') return schema.map(data => ({ textContent: JSON.stringify(data) }));
      assert.fail(`Unexpected selector: ${selector}`);
    },
  };
}

test('uses the captured article metadata, including a speaker, rather than a related article', () => {
  const doc = inspectedDocument({ meta: [['og:site_name', '新闻网站']], schema: [{ '@graph': [
    { '@type': 'NewsArticle', url: 'https://example.org/related', datePublished: '2007-01-01', author: { name: '其他文章作者' } },
    { '@id': '#writer', '@type': 'Person', name: '李明' },
    { '@type': 'NewsArticle', mainEntityOfPage: { '@id': url }, author: { '@id': '#writer' },
      speaker: { name: '王华' }, datePublished: '2026-11-25T10:00:00+08:00', dateModified: '2026-11-26' },
  ] }] });
  assert.deepEqual(extractPageMetadata(doc, url), {
    url, site: '新闻网站', author: '王华、李明', published: '2026-11-25T10:00:00+08:00',
  });
});

test('retains author names and publishes only an explicitly marked date', () => {
  const doc = inspectedDocument({ meta: [['article:modified_time', '2026-11-25'], ['citation_author', 'Byrne'], ['citation_author', '作者：李明']] });
  assert.deepEqual(extractPageMetadata(doc, url), { url, site: '', author: 'Byrne、李明', published: '' });
});

test('escapes webpage values in the header and reserves space for long metadata', () => {
  const page = { paperWidth: 8.27, marginLeft: 0.72, marginRight: 0.72 };
  const metadata = { url, site: '新闻 & 报刊', author: '<img src=x>', published: '未标注' };
  const header = metadataHeader(metadata, page);
  assert.equal(header.displayHeaderFooter, true);
  assert.match(header.headerTemplate, /新闻 &amp; 报刊/);
  assert.match(header.headerTemplate, /&lt;img src=x&gt;/);
  assert.match(header.headerTemplate, /story\?id=20&amp;source=preview/);
  assert.ok(metadataHeader({ ...metadata, url: url + 'x'.repeat(230) }, page).marginTop > header.marginTop);
});
