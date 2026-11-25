const clientIdEl = document.getElementById('clientId');
const apiKeyEl = document.getElementById('apiKey');
const resultEl = document.getElementById('result');
const saveEl = document.getElementById('save');
chrome.storage.local.get(['imaClientId', 'imaApiKey']).then(saved => {
  clientIdEl.value = saved.imaClientId || '';
  apiKeyEl.value = saved.imaApiKey || '';
}).catch(error => {
  resultEl.textContent = `无法读取扩展设置。${error.message}`;
});

saveEl.addEventListener('click', async () => {
  const imaClientId = clientIdEl.value.trim();
  const imaApiKey = apiKeyEl.value.trim();
  if (!imaClientId || !imaApiKey) { resultEl.textContent = '请填写两项凭证'; return; }
  saveEl.disabled = true;
  resultEl.textContent = '正在测试连接…';
  try {
    const client = Ima.createImaClient({ clientId: imaClientId, apiKey: imaApiKey });
    const libraries = await client.listLibraries();
    await chrome.storage.local.set({ imaClientId, imaApiKey });
    resultEl.textContent = `连接成功，凭证已保存。可写入知识库 ${libraries.length} 个。`;
  } catch (error) {
    resultEl.textContent = `凭证未保存。${error.message}`;
  } finally {
    saveEl.disabled = false;
  }
});
