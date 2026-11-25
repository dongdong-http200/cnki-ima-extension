(() => {
  const url = location.href;
  const articleTags = new Set([
    'a', 'abbr', 'article', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'div',
    'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
    'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var',
  ]);
  const omittedTags = new Set(['canvas', 'embed', 'iframe', 'math', 'noscript', 'object', 'script', 'style', 'svg', 'template']);
  const output = document.implementation.createHTMLDocument();

  function safeUrl(value, image = false) {
    if (!value) return '';
    if (image && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(value)) return value;
    try {
      const absolute = new URL(value, document.baseURI);
      return /^https?:$/.test(absolute.protocol) && !absolute.username && !absolute.password ? absolute.href : '';
    } catch { return ''; }
  }

  function copyContent(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(output.createTextNode(node.textContent));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return;
    const tag = node.localName;
    if (omittedTags.has(tag)) return;
    if (!articleTags.has(tag)) {
      for (const child of node.childNodes) copyContent(child, parent);
      return;
    }
    const clean = output.createElement(tag);
    if (tag === 'a') {
      const href = safeUrl(node.getAttribute('href'));
      if (href) clean.setAttribute('href', href);
    }
    if (tag === 'img') {
      const src = safeUrl(node.getAttribute('src'), true);
      if (!src) return;
      clean.setAttribute('src', src);
      clean.setAttribute('alt', node.getAttribute('alt') || '');
    }
    if (tag === 'th' || tag === 'td') {
      for (const name of ['rowspan', 'colspan']) {
        const value = node.getAttribute(name);
        if (/^[1-9]\d{0,2}$/.test(value || '')) clean.setAttribute(name, value);
      }
    }
    if (tag === 'ol' || tag === 'li') {
      const name = tag === 'ol' ? 'start' : 'value';
      const value = node.getAttribute(name);
      if (/^-?\d{1,6}$/.test(value || '')) clean.setAttribute(name, value);
    }
    parent.append(clean);
    for (const child of node.childNodes) copyContent(child, clean);
  }

  // Readability modifies its input, so it receives a detached copy of the live page.
  const clone = document.cloneNode(true);
  for (const [index, image] of Array.from(document.images).entries()) {
    // Use the responsive image the browser selected, including pictures with only srcset.
    if (image.naturalWidth && image.currentSrc) clone.images[index].setAttribute('src', image.currentSrc);
  }
  const article = new Readability(clone, { serializer: element => element }).parse();
  if (!article?.content) return { url };

  const reader = output.createElement('article');
  const body = output.createElement('div');
  copyContent(article.content, body);
  if (!body.textContent.trim() && !body.querySelector('img')) return { url };

  const header = output.createElement('header');
  const title = output.createElement('h1');
  title.textContent = article.title?.trim() || document.title;
  header.append(title);
  reader.append(header, body);
  if (article.dir === 'rtl') reader.dir = 'rtl';
  return { url, html: reader.outerHTML };
})();
