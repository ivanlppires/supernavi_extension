/**
 * SuperNavi PathoWeb Extension - Options Page
 */

const apiBaseUrlInput = document.getElementById('apiBaseUrl');
const apiKeyInput = document.getElementById('apiKey');
const debugInput = document.getElementById('debug');
const fabRightInput = document.getElementById('fabRight');
const fabBottomInput = document.getElementById('fabBottom');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statusEl = document.getElementById('status');

// Load saved settings
chrome.storage.sync.get({
  apiBaseUrl: 'http://localhost:3001',
  apiKey: '',
  debug: false,
  fabRight: 18,
  fabBottom: 88,
}, (items) => {
  apiBaseUrlInput.value = items.apiBaseUrl;
  apiKeyInput.value = items.apiKey;
  debugInput.checked = items.debug;
  fabRightInput.value = items.fabRight;
  fabBottomInput.value = items.fabBottom;
});

// Save settings
saveBtn.addEventListener('click', () => {
  const settings = {
    apiBaseUrl: apiBaseUrlInput.value.replace(/\/+$/, ''),
    apiKey: apiKeyInput.value,
    debug: debugInput.checked,
    fabRight: parseInt(fabRightInput.value, 10) || 18,
    fabBottom: parseInt(fabBottomInput.value, 10) || 88,
  };

  chrome.storage.sync.set(settings, () => {
    showStatus('Configuracoes salvas', 'success');
  });
});

// Test connection
testBtn.addEventListener('click', async () => {
  const baseUrl = apiBaseUrlInput.value.replace(/\/+$/, '');
  const apiKey = apiKeyInput.value;

  if (!baseUrl) {
    showStatus('Insira a URL do servidor', 'error');
    return;
  }

  if (!apiKey) {
    showStatus('Insira a chave de API', 'error');
    return;
  }

  showStatus('Testando...', '');

  try {
    const response = await fetch(`${baseUrl}/api/ui-bridge/cases/TEST000000/status`, {
      headers: {
        'Content-Type': 'application/json',
        'x-supernavi-key': apiKey,
      },
    });

    if (response.ok) {
      showStatus('Conexao OK', 'success');
    } else if (response.status === 401 || response.status === 403) {
      showStatus('Chave de API invalida', 'error');
    } else {
      showStatus(`Servidor respondeu com status ${response.status}`, 'error');
    }
  } catch (err) {
    showStatus('Nao foi possivel conectar ao servidor', 'error');
  }
});

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = 'status';
  if (type) {
    statusEl.classList.add(`status--${type}`);
  }
  if (type === 'success') {
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  }
}
