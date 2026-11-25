const metadataIma = typeof module !== 'undefined' ? require('./ima.js') : self.Ima;

// This function also runs on its own in the browser's isolated scripting world.
function extractPageMetadata(doc = document, url = location.href) {
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const meta = new Map();
  for (const node of doc.querySelectorAll('meta[content]')) {
    const value = clean(node.content);
    for (const attr of ['name', 'property', 'itemprop']) {
      const key = node.getAttribute(attr)?.toLowerCase();
      if (key && value) meta.set(key, [...(meta.get(key) || []), value]);
    }
  }
  const firstMeta = (...keys) => keys.map(key => meta.get(key)?.[0]).find(Boolean) || '';
  const nodes = [];
  const queue = [];
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20)) {
    if (script.textContent.length > 1_000_000) continue;
    try { queue.push(JSON.parse(script.textContent)); } catch { /* Skip malformed metadata. */ }
  }
  for (let i = 0; i < queue.length && i < 500; i++) {
    const node = queue[i];
    if (Array.isArray(node)) queue.push(...node.slice(0, 100));
    else if (node && typeof node === 'object') {
      nodes.push(node);
      queue.push(node['@graph'], node.mainEntity);
    }
  }

  const identifiers = new Map(nodes.filter(node => typeof node['@id'] === 'string').map(node => [node['@id'], node]));
  const types = node => [].concat(node['@type'] || []).filter(type => typeof type === 'string')
    .map(type => type.split('/').at(-1));
  function reference(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const target = new URL(value, url);
      target.hash = '';
      return target.href;
    } catch { return ''; }
  }
  const canonical = reference(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'));
  const sameSiteCanonical = canonical && new URL(canonical).hostname === new URL(url).hostname ? canonical : '';
  const articleTypes = /(?:Article|Posting|^Report$|^Interview$|^WebPage$)/;
  const candidates = nodes.filter(node => types(node).some(type => articleTypes.test(type)));
  const references = node => [node.url, node.mainEntityOfPage, node['@id']]
    .map(value => reference(typeof value === 'string' ? value : value?.['@id'])).filter(Boolean);
  const isCurrent = node => references(node).some(address => address === reference(url) || address === sameSiteCanonical);
  const hasPublicationData = node => node.author || node.creator || node.speaker || node.datePublished || node.publisher;
  const currentNodes = candidates.filter(isCurrent).filter(hasPublicationData);
  const unidentified = candidates.filter(node => references(node).length === 0);
  const article = currentNodes.find(node => types(node).some(type => type !== 'WebPage')) || currentNodes[0] ||
    (unidentified.length === 1 ? unidentified[0] : undefined);
  const website = nodes.find(node => types(node).includes('WebSite') && isCurrent(node)) ||
    nodes.find(node => types(node).includes('WebSite') && references(node).some(address => new URL(address).hostname === new URL(url).hostname));
  const entityName = value => typeof value === 'string' ? clean(identifiers.get(value)?.name ||
    (/^(?:https?:|#)/i.test(value) ? '' : value)) : clean(value?.name || identifiers.get(value?.['@id'])?.name);

  const writer = [].concat(meta.get('author') || [], meta.get('citation_author') || [],
    meta.get('dc.creator') || [], meta.get('dcterms.creator') || [], article?.author || article?.creator || [])
    .map(entityName).filter(Boolean);
  const speaker = [].concat(meta.get('speaker') || [], article?.speaker || article?.spokenByCharacter || [])
    .map(entityName).filter(Boolean);
  const stripByline = value => clean(value).replace(/^(?:作者姓名|作者|发言人|演讲人|记者|撰文|by)(?:\s*[：:]\s*|\s+)/i, '');
  const displayedAuthor = doc.querySelector('[rel~="author"], [itemprop="author"] [itemprop="name"], article .byline, article .author');
  const siteLabel = doc.querySelector('link[rel="home"][title], header .logo img[alt], [role="banner"] .logo img[alt]');
  const explicit = doc.querySelector('[itemprop="datePublished"], time[pubdate], article header time[datetime]');
  const date = firstMeta('article:published_time', 'citation_publication_date', 'datepublished', 'pubdate', 'publishdate',
    'publish_time', 'dc.date.issued', 'dcterms.issued') || clean(article?.datePublished) ||
    clean(explicit?.getAttribute('datetime') || explicit?.getAttribute('content') || explicit?.textContent);
  return {
    url,
    site: firstMeta('og:site_name', 'application-name') || clean(website?.name) || entityName(article?.publisher) ||
      clean(siteLabel?.getAttribute('title') || siteLabel?.getAttribute('alt')) ||
      (new URL(url).pathname === '/' ? clean(doc.title) : ''),
    author: [...new Set([...speaker, ...writer].map(stripByline).filter(Boolean))].slice(0, 8).join('、') ||
      stripByline(displayedAuthor?.textContent),
    published: date,
  };
}

async function readPageMetadata(tabId, url) {
  let result;
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId }, func: extractPageMetadata, world: 'ISOLATED',
    });
    result = execution?.result;
  } catch { /* Printing can still include the source address when metadata is inaccessible. */ }
  if (result && metadataIma.normalizeWebUrl(result.url) !== url) {
    throw new Error('当前页面已切换，请重新打开扩展。');
  }
  return { url, site: result?.site || new URL(url).hostname, author: result?.author || '未标注', published: result?.published || '未标注' };
}

function metadataHeader(metadata, options) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const { paperWidth, marginLeft, marginRight } = options;
  const rows = [
    ['网站名称', metadata.site],
    ['作者 / 发言人', metadata.author],
    ['公布时间', metadata.published],
  ];
  const safeUrl = escape(metadata.url);
  const metadataText = [...rows.map(([label, value]) => `${label} ${value}`), `来源网址 ${metadata.url}`];
  const charactersPerLine = Math.max(24, Math.floor((paperWidth - marginLeft - marginRight) * 72 / 9));
  const lines = metadataText.reduce((total, value) => total + Math.ceil(Array.from(value).length / charactersPerLine), 0);
  return {
    displayHeaderFooter: true,
    marginTop: Math.max(1.05, 0.40 + lines * 0.15),
    headerTemplate: `<div style="box-sizing:border-box;width:100%;padding:0 ${marginRight}in 0 ${marginLeft}in;font:8.5pt/1.25 sans-serif;color:#273444;overflow-wrap:anywhere">
      <div style="border-bottom:1px solid #cbd5e1;padding-bottom:4pt">
        ${rows.map(([label, value]) => `<div><strong>${label}</strong>　${escape(value)}</div>`).join('')}
        <div><strong>来源网址</strong>　<a style="color:#245581" href="${safeUrl}">${safeUrl}</a></div>
      </div>
    </div>`,
    footerTemplate: '<span></span>',
  };
}

const webpageMetadataApi = { extractPageMetadata, readPageMetadata, metadataHeader };
if (typeof module !== 'undefined') module.exports = webpageMetadataApi;
if (typeof self !== 'undefined') self.WebpageMetadata = webpageMetadataApi;
