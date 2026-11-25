const test = require('node:test');
const assert = require('node:assert/strict');
const { createImaClient, normalizeWebUrl } = require('../src/ima.js');

const credentials = { clientId: 'id', apiKey: 'key' };
const bytes = new TextEncoder().encode('%PDF-1.7\n%%EOF').buffer;

function fakeApi(responses, calls) {
  return async (url, init) => {
    const action = url.split('/').pop();
    calls.push({ action, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => responses[action] };
  };
}

test('Ima imports links into the exact selected folder and uses the library ID for its root', async () => {
  const url = 'https://example.org/article?ref=guide#method';
  const calls = [];
  const client = createImaClient(credentials, fakeApi({
    import_urls: { code: 0, data: { results: { [url]: { url, ret_code: 0, media_id: 'page' } } } },
  }, calls));
  for (const folderId of ['nested-folder', '']) {
    assert.equal(await client.importWebLink({ url, knowledgeBaseId: 'library', folderId }), 'page');
  }
  assert.deepEqual(calls.map(call => call.action), ['import_urls', 'import_urls']);
  assert.deepEqual(calls.map(call => call.body), [
    { knowledge_base_id: 'library', folder_id: 'nested-folder', urls: [url] },
    { knowledge_base_id: 'library', folder_id: 'library', urls: [url] },
  ]);
});

test('per-link errors are reported even when the IMA request itself succeeded', async () => {
  const url = 'https://example.org/article';
  const calls = [];
  const client = createImaClient(credentials, fakeApi({
    import_urls: { code: 0, data: { results: { [url]: { url, ret_code: 42 } } } },
  }, calls));
  await assert.rejects(client.importWebLink({ url, knowledgeBaseId: 'library', folderId: 'folder' }), /未能导入网页链接.*42/);
  assert.equal(calls.length, 1);
});

test('browser pages, local files, credentials and incomplete responses do not count as saved links', async () => {
  for (const url of ['edge://settings/', 'file:///tmp/site.html', 'https://reader:password@example.org/']) {
    assert.equal(normalizeWebUrl(url), null);
  }
  const calls = [];
  const client = createImaClient(credentials, fakeApi({ import_urls: { code: 0, data: { results: {} } } }, calls));
  await assert.rejects(client.importWebLink({ url: 'file:///tmp/site.html', knowledgeBaseId: 'library', folderId: '' }), /有效/);
  assert.equal(calls.length, 0);
  await assert.rejects(client.importWebLink({ url: 'https://example.org/', knowledgeBaseId: 'library', folderId: '' }), /未返回这条链接的导入结果/);
});

test('explains rejected IMA credentials and keeps authenticated requests on the official endpoint', async () => {
  const client = createImaClient(credentials, async (url, init) => {
    assert.equal(url, 'https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list');
    assert.equal(init.redirect, 'error');
    return { ok: false, status: 401 };
  });
  await assert.rejects(client.listLibraries(), /HTTP 401.*扩展设置.*重新测试连接/);
});

test('an ambiguous IMA save timeout tells the reader to verify the destination before retrying', async () => {
  const client = createImaClient(credentials, async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    throw new DOMException('response timed out', 'TimeoutError');
  });
  await assert.rejects(client.request('add_knowledge', {}), /保存响应超时.*先核对知识库/);
});

test('lists writable libraries and uploads PDF before registering it', async () => {
  const calls = [];
  const responses = {
    get_addable_knowledge_base_list: { code: 0, data: { addable_knowledge_base_list: [{ id: 'kb1', name: '文献' }], is_end: true } },
    check_repeated_names: { code: 0, data: { results: [{ name: '论文.pdf', is_repeated: false }] } },
    create_media: { code: 0, data: { media_id: 'media1', cos_credential: { cos_key: 'file', bucket_name: 'bucket', region: 'ap-test', secret_id: 'a', secret_key: 'b' } } },
    add_knowledge: { code: 0, data: { media_id: 'media1' } },
  };
  const client = createImaClient(credentials, fakeApi(responses, calls));
  assert.deepEqual(await client.listLibraries(), [{ id: 'kb1', name: '文献' }]);
  const uploads = [];
  const id = await client.uploadPdf({ buffer: bytes, fileName: '论文.pdf', knowledgeBaseId: 'kb1', cosUpload: async (...args) => { uploads.push(args); } });
  assert.equal(id, 'media1');
  assert.equal(uploads.length, 1);
  assert.deepEqual(calls.map(c => c.action), ['get_addable_knowledge_base_list', 'check_repeated_names', 'create_media', 'add_knowledge']);
  assert.equal(calls[3].body.file_info.file_name, '论文.pdf');
  assert.equal(calls[3].body.media_type, 1);
  assert.equal(calls[0].headers['ima-openapi-apikey'], 'key');
});

test('duplicate and failed COS upload never register knowledge', async () => {
  const calls = [];
  const responses = {
    check_repeated_names: { code: 0, data: { results: [{ name: '论文.pdf', is_repeated: true }] } },
    create_media: { code: 0, data: { media_id: 'media1', cos_credential: { cos_key: 'file' } } },
  };
  const client = createImaClient(credentials, fakeApi(responses, calls));
  await assert.rejects(client.uploadPdf({ buffer: bytes, fileName: '论文.pdf', knowledgeBaseId: 'kb1', cosUpload: async () => {} }), /同名/);
  assert.deepEqual(calls.map(c => c.action), ['check_repeated_names']);
  responses.check_repeated_names.data.results[0].is_repeated = false;
  await assert.rejects(client.uploadPdf({ buffer: bytes, fileName: '论文.pdf', knowledgeBaseId: 'kb1', cosUpload: async () => { throw new Error('COS failed'); } }), /COS failed/);
  assert.equal(calls.some(c => c.action === 'add_knowledge'), false);
});

test('missing duplicate-check result cannot proceed to media creation', async () => {
  const calls = [];
  const client = createImaClient(credentials, fakeApi({ check_repeated_names: { code: 0, data: {} } }, calls));
  await assert.rejects(client.uploadPdf({ buffer: bytes, fileName: '论文.pdf', knowledgeBaseId: 'kb1', cosUpload: async () => {} }), /重名检查/);
  assert.deepEqual(calls.map(c => c.action), ['check_repeated_names']);
});

test('lists nested folders from ima knowledge entries', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ action: url.split('/').pop(), body });
    const root = !body.folder_id;
    return { ok: true, json: async () => ({ code: 0, data: {
      knowledge_list: root
        ? [{ media_id: 'f1', title: '参考文献', media_type: 99 }, { media_id: 'pdf1', title: '论文.pdf', media_type: 1 }]
        : body.folder_id === 'f1' ? [{ media_id: 'f2', title: '养老金', media_type: 99 }] : [],
      is_end: true,
    } }) };
  };
  const folders = await createImaClient(credentials, fetchImpl).listFolders('kb1');
  assert.deepEqual(folders, [
    { id: 'f1', name: '参考文献', path: '参考文献' },
    { id: 'f2', name: '养老金', path: '参考文献 / 养老金' },
  ]);
  assert.deepEqual(calls.map(c => c.body.folder_id), [undefined, 'f1', 'f2']);
});

test('checks duplicate and adds PDF within selected folder', async () => {
  const calls = [];
  const responses = {
    check_repeated_names: { code: 0, data: { results: [{ name: '论文.pdf', is_repeated: false }] } },
    create_media: { code: 0, data: { media_id: 'm1', cos_credential: { cos_key: 'file' } } },
    add_knowledge: { code: 0, data: { media_id: 'm1' } },
  };
  await createImaClient(credentials, fakeApi(responses, calls)).uploadPdf({
    buffer: bytes, fileName: '论文.pdf', knowledgeBaseId: 'kb1', folderId: 'f1', cosUpload: async () => {},
  });
  assert.equal(calls[0].body.folder_id, 'f1');
  assert.equal(calls[2].body.folder_id, 'f1');
});
