# SuperNavi - Bridge Extension

Extensão Chrome que conecta o [SuperNavi](https://viewer.supernavi.app) ao sistema de gestão da clínica, permitindo abrir lâminas digitais no Viewer com fluidez — direto da tela do sistema que você já usa.

## Ideia

Cada clínica usa um sistema diferente para gerenciar seus casos (PathoWeb, sistemas próprios, etc.). A extensão lê da tela o código do caso e informações relevantes, consulta o SuperNavi e exibe as lâminas digitalizadas no momento certo — sem trocar de aba, sem copiar e colar.

A cada atualização, novos sistemas são adicionados. Basta que o sistema exiba o código do caso na tela para a extensão funcionar.

### Sistemas integrados

| Sistema | Status | Desde |
|---------|--------|-------|
| PathoWeb (`pathoweb.com.br`) | Disponível | v1.0.0 |

> Usa um sistema diferente? [Entre em contato](mailto:contato@supernavi.app) — a integração é simples e rápida.

## Como funciona

1. O usuário navega para um caso no sistema da clínica
2. A extensão detecta automaticamente o código do caso na tela
3. Um handle lateral **SUPERNAVI** aparece na borda direita
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
3. Após parear, a extensão autentica automaticamente todas as requisições

Para desparear, acesse as opções da extensão (clique direito no ícone > Opções) e clique em **Desparear**.

## Arquitetura

```
┌──────────────────┐     ┌───────────────────┐     ┌─────────────────┐
│  content.js      │────▶│  background.js    │────▶│  SuperNavi      │
│  (DOM do sistema)│◀────│  (Service Worker) │◀────│  Cloud API      │
└──────────────────┘     └───────────────────┘     └─────────────────┘
```

| Arquivo | Responsabilidade |
|---------|-----------------|
| `manifest.json` | Configuração Manifest V3, permissões, content scripts |
| `content.js` | Detecta códigos de caso no DOM do sistema, injeta handle e drawer |
| `background.js` | Service worker — chamadas à API, cache de status, pareamento |
| `options.html/js` | Página de opções (pareamento, configurações) |
| `ui.css` | Estilização do handle, drawer e componentes injetados |

### Content Script (`content.js`)

- Detecta códigos de caso via regex (ex: `AP`, `PA`, `IM`, `C` + dígitos)
- Normaliza prefixos (`PA` → `AP`)
- Extrai dados do paciente (nome, idade, médico) do DOM quando disponíveis
- Cria handle lateral (18px, borda direita) com texto vertical "SUPERNAVI"
- Drawer de 320px com lista de lâminas, thumbnails e links para o viewer
- Fluxo de pareamento inline (campo de código de 6 caracteres)
- `MutationObserver` para detectar navegação SPA
- Polling de status a cada 30s enquanto o drawer está aberto

### Background Service Worker (`background.js`)

- Todas as chamadas à API passam pelo service worker (CORS-free)
- Cache in-memory de status de caso (TTL 30s)
- Autenticação via `x-device-token` (pareamento)
- Mensageria: `CASE_DETECTED`, `GET_AUTH_INFO`, `CLAIM_PAIRING_CODE`, `REQUEST_VIEWER_LINK`, `REFRESH_STATUS`

## Permissões

| Permissão | Motivo |
|-----------|--------|
| `storage` | Armazenar token de pareamento e configurações |
| `host: pathoweb.com.br` | Content script no PathoWeb |
| `host: cloud.supernavi.app` | Chamadas à API do SuperNavi |

## Configuração

Acessível via opções da extensão:

| Campo | Default | Descrição |
|-------|---------|-----------|
| Server URL | `https://cloud.supernavi.app` | URL da API SuperNavi |
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

Para testar, acesse qualquer caso no sistema integrado que contenha um código de caso com lâminas digitalizadas no SuperNavi.
