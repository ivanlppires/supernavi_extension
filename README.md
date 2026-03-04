# SuperNavi - Bridge Extension

Extensão do Chrome que conecta o **SuperNavi Viewer** ao sistema de gestão de casos da clínica, permitindo **abrir lâminas digitais (WSI)** no Viewer com fluidez — direto da tela do sistema que você já usa.

- Viewer: https://viewer.supernavi.app  
- Site: https://supernavi.app  
- Suporte: support@supernavi.app  
- Privacidade: privacy@supernavi.app  

---

## Visão geral

Cada clínica pode usar um sistema diferente para gerenciar seus casos (PathoWeb, sistemas próprios, etc.). Esta extensão foi projetada para funcionar como uma **ponte**: ela identifica o **código do caso** exibido na interface do sistema, consulta o SuperNavi e apresenta as lâminas associadas, reduzindo fricção no fluxo de trabalho.

> **Importante:** na versão atual, a integração disponível é com **PathoWeb**. A arquitetura da extensão foi pensada para facilitar novas integrações conforme necessário.

### Sistemas integrados

| Sistema | Status | Desde |
|--------|--------|-------|
| PathoWeb (`pathoweb.com.br`) | Disponível | v1.0.0 |

Usa outro sistema e quer integrar? Fale com a equipe: **support@supernavi.app**

---

## Como funciona

1. O usuário acessa um caso no sistema da clínica
2. A extensão detecta o **código do caso** na tela
3. Um handle lateral **SUPERNAVI** aparece na borda direita
4. Ao clicar, abre um drawer com as lâminas disponíveis para aquele caso
5. Clique em uma lâmina para abrir no **SuperNavi Viewer** (tela cheia, pan/zoom)

---

## Instalação

### Chrome Web Store (recomendado)
Instale diretamente pela Chrome Web Store (sem modo desenvolvedor).  
> Link: **(inserir URL do item publicado)**

### Modo desenvolvedor (dev)
1. Clone este repositório
2. Acesse `chrome://extensions/` e ative **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto
4. A extensão aparecerá na barra do Chrome

---

## Pareamento

A extensão precisa estar pareada com uma conta SuperNavi para autenticar chamadas e liberar funcionalidades.

1. No Viewer (`viewer.supernavi.app`), vá em **Configurações > Dispositivos** e gere um código de pareamento
2. Na extensão, insira o código de 6 caracteres no drawer ou na página de opções
3. Após parear, a extensão autentica automaticamente as requisições necessárias

Para desparear, acesse **Opções** (clique direito no ícone → Opções) e clique em **Desparear**.

---

## Privacidade (resumo)

A extensão processa **apenas o mínimo necessário** para cumprir seu propósito (ponte entre o sistema da clínica e o SuperNavi), como:
- Identificador/código do caso exibido na interface do sistema integrado
- Tokens de pareamento/autenticação e preferências técnicas armazenados localmente via `chrome.storage`

A extensão:
- **não vende dados**
- **não usa dados para publicidade**
- **não coleta histórico de navegação**
- **não realiza diagnóstico**

Política completa: https://supernavi.app/privacy

---

## Arquitetura

```text
┌──────────────────────┐      ┌─────────────────────────┐      ┌──────────────────────┐
│ content.js           │      │ background.js           │      │ SuperNavi Cloud API   │
│ (DOM do sistema)     │─────▶│ (Service Worker - MV3)  │─────▶│ cloud.supernavi.app   │
│                      │◀─────│                         │◀─────│                      │
└──────────────────────┘      └─────────────────────────┘      └──────────────────────┘
```

| Arquivo | Responsabilidade |
|---------|------------------|
| `manifest.json` | Manifest V3, permissões, content scripts |
| `content.js` | Detecta código do caso no DOM, injeta handle/drawer |
| `background.js` | Service worker: chamadas à API, pareamento, cache |
| `options.html/js` | Página de opções (pareamento, configurações) |
| `ui.css` | Estilo do handle/drawer e UI injetada |

### Content Script (`content.js`)
- Detecta códigos de caso via regex (ex.: `AP`, `PA`, `IM`, `C` + dígitos)
- Normaliza prefixos quando necessário
- Lê metadados **visíveis na tela** quando disponíveis (ex.: rótulos/identificadores do caso) **somente para contextualização**
- Injeta handle lateral (18px, borda direita) com texto vertical “SUPERNAVI”
- Drawer (~320px) com lista de lâminas, thumbs e links para o Viewer
- Fluxo de pareamento inline (código de 6 caracteres)
- `MutationObserver` para navegação SPA
- Atualização de status enquanto o drawer estiver aberto

### Background Service Worker (`background.js`)
- Centraliza chamadas à API no service worker
- Cache in-memory de status de caso (TTL curto)
- Autenticação via token de dispositivo (pareamento)
- Mensageria: `CASE_DETECTED`, `GET_AUTH_INFO`, `CLAIM_PAIRING_CODE`, `REQUEST_VIEWER_LINK`, `REFRESH_STATUS`

---

## Permissões

| Permissão | Motivo |
|-----------|--------|
| `storage` | Armazenar token de pareamento e configurações |
| `host: pathoweb.com.br` | Executar content script no sistema integrado (PathoWeb) |
| `host: cloud.supernavi.app` | Chamadas à API do SuperNavi |

---

## Configuração

Acessível via **Opções** da extensão:

| Campo | Default | Descrição |
|-------|---------|-----------|
| Server URL | `https://cloud.supernavi.app` | URL da API SuperNavi |
| Debug | `false` | Logs detalhados no console |

---

## Desenvolvimento

Não há build step: a extensão é composta por arquivos estáticos (HTML/CSS/JS).

```bash
# Carregar no Chrome
# 1. chrome://extensions/ → Modo do desenvolvedor → Carregar sem compactação
# 2. Selecionar a pasta do projeto

# Gerar zip para Chrome Web Store
zip -r supernavi-extension.zip . -x ".git/*" -x "docs/*"
```
