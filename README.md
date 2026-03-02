# SuperNavi - PathoWeb Bridge

Extensão Chrome que integra o [SuperNavi](https://viewer.supernavi.app) ao sistema PathoWeb, permitindo visualização rápida de lâminas digitalizadas diretamente na tela de exames.

## Como funciona

1. O usuário navega para um exame no PathoWeb (`pathoweb.com.br/moduloExame/...`)
2. A extensão detecta automaticamente o número do caso (AP, PA, IM, C + dígitos)
3. Um handle lateral **SUPERNAVI** aparece na borda direita da tela
4. Ao clicar, abre um drawer com as lâminas digitalizadas daquele caso
5. Clique em uma lâmina para abrir o viewer em tela cheia com zoom de alta resolução

## Instalação

### Chrome Web Store (recomendado)

Instale diretamente pela [Chrome Web Store](#) — sem necessidade de modo desenvolvedor.

### Modo desenvolvedor (dev)

1. Clone o repositório
2. Acesse `chrome://extensions/` e ative **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e selecione esta pasta
4. A extensão aparece na barra do Chrome

## Pareamento

A extensão precisa estar pareada com uma conta SuperNavi para funcionar.

1. No viewer (`viewer.supernavi.app`), vá em **Configurações > Dispositivos** e gere um código de pareamento
2. Na extensão, insira o código de 6 caracteres no drawer ou na página de opções
3. Após parear, a extensão autentica via `x-device-token` em todas as requisições

Para desparear, acesse as opções da extensão (clique direito no ícone > Opções) e clique em **Desparear**.

## Arquitetura

```
┌──────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│  content.js      │────▶│  background.js    │────▶│  SuperNavi      │
│  (PathoWeb DOM)  │◀────│  (Service Worker) │◀────│  Cloud API      │
└──────────────────┘     └───────────────────┘     └─────────────────┘
```

| Arquivo | Responsabilidade |
|---------|-----------------|
| `manifest.json` | Configuração Manifest V3, permissões, content scripts |
| `content.js` | Detecta casos no DOM do PathoWeb, injeta handle e drawer |
| `background.js` | Service worker — chamadas à API, cache de status, pareamento |
| `options.html/js` | Página de opções (pareamento, configurações avançadas) |
| `ui.css` | Estilização do handle, drawer e componentes injetados |

### Content Script (`content.js`)

- Detecta números de caso via regex: `AP`, `PA`, `IM`, `C` + 6-12 dígitos
- Normaliza prefixos (`PA` → `AP`)
- Scrapes dados do paciente (nome, idade, médico requisitante) do DOM
- Cria handle lateral (18px, borda direita) com texto vertical "SUPERNAVI"
- Drawer de 320px com lista de lâminas, thumbnails e links para o viewer
- Fluxo de pareamento inline (campo de código de 6 caracteres)
- `MutationObserver` para detectar navegação SPA no PathoWeb
- Polling de status a cada 30s enquanto o drawer está aberto

### Background Service Worker (`background.js`)

- Todas as chamadas à API passam pelo service worker (CORS-free)
- Cache in-memory de status de caso (TTL 30s)
- Autenticação dual: `x-device-token` (pareamento) ou `x-supernavi-key` (API key legada)
- Mensageria: `CASE_DETECTED`, `GET_AUTH_INFO`, `CLAIM_PAIRING_CODE`, `REQUEST_VIEWER_LINK`, `REFRESH_STATUS`

## Permissões

| Permissão | Motivo |
|-----------|--------|
| `storage` | Armazenar token de pareamento e configurações |
| `activeTab` | Acessar a aba ativa para injeção de conteúdo |
| `host: pathoweb.com.br` | Content script no PathoWeb |
| `host: cloud.supernavi.app` | Chamadas à API do SuperNavi |

## Configuração

Acessível via opções da extensão:

| Campo | Default | Descrição |
|-------|---------|-----------|
| Server URL | `https://cloud.supernavi.app` | URL da API SuperNavi |
| API Key | (vazio) | Chave de API legada (substituída por pareamento) |
| Debug | `false` | Logs detalhados no console |

## Desenvolvimento

Não há build step — a extensão é composta por arquivos estáticos (HTML, CSS, JS vanilla).

```bash
# Carregar no Chrome
# 1. chrome://extensions/ → Modo do desenvolvedor → Carregar sem compactação
# 2. Selecionar esta pasta

# Gerar zip para Chrome Web Store
zip -r supernavi-extension.zip . -x ".git/*" -x "docs/*"
```

Para testar, acesse qualquer exame no PathoWeb que contenha um número de caso (ex: `AP26000454`) com lâminas digitalizadas no SuperNavi.
