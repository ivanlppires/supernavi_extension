/**
 * SuperNavi PathoWeb Extension - Options Page
 */

// Legacy fields
const apiBaseUrlInput = document.getElementById('apiBaseUrl');
const apiKeyInput = document.getElementById('apiKey');

// Pairing fields
const pairServerUrlInput = document.getElementById('pairServerUrl');
const pairCodeInput = document.getElementById('pairCode');
const pairBtn = document.getElementById('pairBtn');
const pairedStatusEl = document.getElementById('pairedStatus');
const pairedNameEl = document.getElementById('pairedName');
const pairingFormEl = document.getElementById('pairingForm');
const unpairSectionEl = document.getElementById('unpairSection');
const unpairBtn = document.getElementById('unpairBtn');

// Settings fields
const debugInput = document.getElementById('debug');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statusEl = document.getElementById('status');

// Load saved settings
chrome.storage.sync.get({
  apiBaseUrl: 'http://localhost:3001',
  apiKey: '',
  deviceToken: '',
  deviceId: '',
  deviceName: '',
  debug: false,
}, (items) => {
  apiBaseUrlInput.value = items.apiBaseUrl;
  apiKeyInput.value = items.apiKey;
  pairServerUrlInput.value = items.apiBaseUrl;
  debugInput.checked = items.debug;

  // Show paired status if device is paired
  if (items.deviceToken && items.deviceId) {
    showPairedState(items.deviceName || 'Dispositivo pareado');
  }
});

function showPairedState(name) {
  pairedStatusEl.style.display = 'flex';
  pairedNameEl.textContent = `Pareado como ${name}`;
  pairingFormEl.style.display = 'none';
  unpairSectionEl.style.display = 'block';
}

function showUnpairedState() {
  pairedStatusEl.style.display = 'none';
  pairingFormEl.style.display = 'block';
  unpairSectionEl.style.display = 'none';
}

// Pair button
pairBtn.addEventListener('click', async () => {
  const serverUrl = pairServerUrlInput.value.replace(/\/+$/, '');
  const code = pairCodeInput.value.trim().toUpperCase();

  if (!serverUrl) {
    showStatus('Insira a URL do servidor', 'error');
    return;
  }

  if (!code || code.length !== 6) {
    showStatus('Insira o codigo de 6 caracteres', 'error');
    return;
  }

  pairBtn.disabled = true;
  pairBtn.textContent = 'Pareando...';
  showStatus('Conectando ao servidor...', '');

  try {
    const response = await fetch(`${serverUrl}/api/ui-bridge/pairing/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (response.status === 404) {
      showStatus('Codigo invalido', 'error');
      return;
    }

    if (response.status === 410) {
      showStatus('Codigo expirado ou ja utilizado', 'error');
      return;
    }

    if (response.status === 429) {
      showStatus('Muitas tentativas. Aguarde 1 minuto.', 'error');
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      showStatus(`Erro ${response.status}: ${text}`, 'error');
      return;
    }

    const data = await response.json();

    // Save pairing data + server URL
    chrome.storage.sync.set({
      apiBaseUrl: serverUrl,
      deviceToken: data.deviceToken,
      deviceId: data.deviceId,
      deviceName: data.deviceName,
    }, () => {
      showStatus('Pareado com sucesso!', 'success');
      showPairedState(data.deviceName);
      // Also update legacy URL field
      apiBaseUrlInput.value = serverUrl;
    });
  } catch (err) {
    showStatus('Nao foi possivel conectar ao servidor', 'error');
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Parear';
  }
});

// Unpair button
unpairBtn.addEventListener('click', () => {
  chrome.storage.sync.set({
    deviceToken: '',
    deviceId: '',
    deviceName: '',
  }, () => {
    showUnpairedState();
    pairCodeInput.value = '';
    showStatus('Dispositivo desconectado', 'success');
  });
});

// Auto-uppercase pairing code input
pairCodeInput.addEventListener('input', () => {
  pairCodeInput.value = pairCodeInput.value.toUpperCase();
});

// Save settings
saveBtn.addEventListener('click', () => {
  const settings = {
    apiBaseUrl: apiBaseUrlInput.value.replace(/\/+$/, ''),
    apiKey: apiKeyInput.value,
    debug: debugInput.checked,
  };

  chrome.storage.sync.set(settings, () => {
    // Also sync pairing server URL
    pairServerUrlInput.value = settings.apiBaseUrl;
    showStatus('Configuracoes salvas', 'success');
  });
});

// Test connection
testBtn.addEventListener('click', async () => {
  // Determine which auth method to use
  const config = await new Promise(resolve => {
    chrome.storage.sync.get({
      apiBaseUrl: 'http://localhost:3001',
      apiKey: '',
      deviceToken: '',
    }, resolve);
  });

  const baseUrl = config.apiBaseUrl;

  if (!baseUrl) {
    showStatus('Insira a URL do servidor', 'error');
    return;
  }

  const headers = { 'Content-Type': 'application/json' };

  if (config.deviceToken) {
    headers['x-device-token'] = config.deviceToken;
  } else if (config.apiKey) {
    headers['x-supernavi-key'] = config.apiKey;
  } else {
    showStatus('Configure o pareamento ou insira a chave de API', 'error');
    return;
  }

  showStatus('Testando...', '');

  try {
    const response = await fetch(`${baseUrl}/api/ui-bridge/cases/TEST000000/status`, {
      headers,
    });

    if (response.ok) {
      showStatus('Conexao OK', 'success');
    } else if (response.status === 401 || response.status === 403) {
      showStatus('Autenticacao invalida', 'error');
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
