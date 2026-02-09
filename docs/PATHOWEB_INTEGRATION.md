# PathoWeb-SuperNavi Integration

Integracao "zero-cost" entre o SuperNavi e o PathoWeb (LIS de patologia). Nenhum acesso a API do PathoWeb e necessario -- a extensao Chrome extrai o numero do caso diretamente da pagina.

## Arquitetura

```
PathoWeb (browser)
  |
  v
Chrome Extension  ──────────>  SuperNavi Cloud (UI-Bridge API)
  - Detecta AP######           - GET /cases/:caseBase/status
  - Mostra FAB stealth         - POST /viewer-link (magic link)
  - Abre viewer via magic link - GET /thumb/:slideId (HMAC signed)
                                 - POST /cases/:caseBase/attach
```

## Componentes

| Componente | Diretorio | Funcao |
|------------|-----------|--------|
| Edge filename parser | `supernavi_edge/api/src/lib/filename-parser.js` | Extrai `caseBase` + `label` do nome SVS |
| Edge migration 006 | `supernavi_edge/db/migrations/006_*` | Campos `external_case_*` na tabela `slides` |
| Cloud sync schemas | `supernavi_cloud/src/sync/schemas.ts` | Aceita `SlideRegistered` com campos externos |
| Cloud projections | `supernavi_cloud/src/sync/projections.ts` | Projeta campos externos em `slides_read` |
| Cloud UI-Bridge API | `supernavi_cloud/src/modules/ui-bridge/` | Endpoints para extensao |
| Chrome Extension | `supernavi_extension/` | Content script + background + options |
| Frontend magic link | `supernavi_frontend/src/pages/viewer.vue` | Viewer read-only com `?t=` token |

---

## Configuracao

### Variaveis de ambiente (Cloud `.env`)

```bash
# Chave de API para autenticacao da extensao Chrome
UI_BRIDGE_API_KEY=snavi-prod-bridge-key-CHANGEME

# Secret para assinar magic links JWT (obrigatorio em producao)
MAGIC_LINK_SECRET=your-random-secret-32-chars-minimum

# TTL do magic link em segundos (padrao: 300 = 5 min)
MAGIC_LINK_TTL_SECONDS=300

# Secret para assinar thumb URLs (padrao: usa MAGIC_LINK_SECRET)
THUMB_SIGN_SECRET=optional-separate-secret

# TTL da assinatura de thumbs em segundos (padrao: 600 = 10 min)
THUMB_SIGN_TTL_SECONDS=600

# URL do frontend para construir magic links
FRONTEND_URL=https://app.supernavi.app
```

### Instalacao da Extensao Chrome

1. Abra `chrome://extensions/`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactacao**
4. Selecione a pasta `supernavi_extension/`
5. Clique no icone da extensao > **Opcoes**
6. Configure:
   - **URL do servidor:** `https://api.supernavi.app` (ou `http://localhost:3001` para dev)
   - **Chave de API:** o valor de `UI_BRIDGE_API_KEY`
7. Clique em **Testar conexao** para verificar
8. Clique em **Salvar**

---

## API Reference

Todos os endpoints exigem header `x-supernavi-key` (exceto o thumb que usa HMAC).

### GET `/api/ui-bridge/cases/:caseBase/status`

Aceita `:caseBase` como `AP26000230` ou `pathoweb:AP26000230`.

**Response:**
```json
{
  "caseBase": "AP26000230",
  "externalCaseId": "pathoweb:AP26000230",
  "readySlides": [
    {
      "slideId": "abc123...",
      "label": "A2",
      "thumbUrl": "/api/ui-bridge/thumb/abc123...?exp=1738800000&sig=...",
      "width": 40000,
      "height": 30000
    }
  ],
  "processingSlides": [],
  "unconfirmedCandidates": [],
  "lastUpdated": "2026-02-06T12:00:00.000Z"
}
```

### POST `/api/ui-bridge/viewer-link`

**Body:** `{ "slideId": "abc123...", "externalCaseId": "pathoweb:AP26000230" }`

**Response:**
```json
{
  "url": "https://app.supernavi.app/viewer?slideId=abc123...&t=eyJ...",
  "token": "eyJ...",
  "expiresIn": 300
}
```

### POST `/api/ui-bridge/cases/:caseBase/attach`

**Body:** `{ "slideId": "abc123..." }`

**Response:** `{ "ok": true, "slideId": "abc123...", "caseBase": "AP26000230", "externalCaseId": "pathoweb:AP26000230" }`

### GET `/api/ui-bridge/thumb/:slideId?exp=EPOCH&sig=HEX`

Sem header de auth -- autenticado via HMAC na query string.
Retorna **302 redirect** para URL assinada do Wasabi.

---

## Seguranca

| Mecanismo | Descricao |
|-----------|-----------|
| API Key | Header `x-supernavi-key` valida a extensao Chrome |
| HMAC Thumbs | URLs de thumbnail assinadas com SHA-256 + expiracao, sem headers de auth (funciona em `<img>`) |
| Magic Link JWT | Token bind: `slideId` + `externalCaseId` + `purpose:viewer` + `readOnly:true` + `exp` |
| Viewer Read-Only | Magic links desativam ferramentas de anotacao, desenho e medicao |
| Timing-safe compare | `crypto.timingSafeEqual` na verificacao de assinatura HMAC |
| Audit Log | Toda criacao de magic link e attach e logada em `viewer_audit_log` |

---

## Teste rapido

```bash
# 1. Verificar status de um caso
curl -s -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  http://localhost:3001/api/ui-bridge/cases/AP26000230/status | jq .

# 2. Testar com prefixo pathoweb:
curl -s -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  'http://localhost:3001/api/ui-bridge/cases/pathoweb:AP26000230/status' | jq .

# 3. Gerar magic link (substitua SLIDE_ID)
curl -s -X POST -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  -H 'Content-Type: application/json' \
  -d '{"slideId":"SLIDE_ID_HERE"}' \
  http://localhost:3001/api/ui-bridge/viewer-link | jq .
```

---

## Roteiro de Demo (Dr. Marcos) -- 6 passos

### Passo 1: Digitalizar uma lamina

Copie o arquivo `AP26000230A2.svs` para a pasta de inbox do edge:

```bash
cp AP26000230A2.svs ~/supernavi/data/inbox/
```

Aguarde ~5 segundos. O edge detecta o arquivo, calcula o hash SHA-256, extrai os metadados e o filename parser identifica automaticamente:
- **Caso:** `AP26000230`
- **Lamina:** `A2`

Verificacao (opcional):
```bash
docker compose exec db psql -U supernavi -c \
  "SELECT slide_id, external_case_base, external_slide_label FROM slides ORDER BY created_at DESC LIMIT 1;"
```

### Passo 2: Verificar no cloud

Apos o sync automatico, o cloud recebe o evento `SlideRegistered` com os campos externos:

```bash
curl -s -H 'x-supernavi-key: snavi-dev-bridge-key-2026' \
  http://localhost:3001/api/ui-bridge/cases/AP26000230/status | jq .
```

Voce vera `readySlides` com a lamina `A2` listada (ou `processingSlides` se o preview ainda estiver sendo gerado).

### Passo 3: Instalar a extensao

1. Abra `chrome://extensions/`
2. Ative "Modo do desenvolvedor"
3. "Carregar sem compactacao" -> selecione `supernavi_extension/`
4. Nas opcoes, configure URL e API key
5. Clique "Testar conexao" -> deve mostrar "Conexao OK"

### Passo 4: Abrir o PathoWeb

Navegue para o exame `AP26000230` no PathoWeb. A extensao:
1. Detecta o numero `AP26000230` na pagina
2. Consulta o SuperNavi API em background
3. Mostra um **botao circular discreto** no canto inferior direito (28px, quase transparente)
4. O ponto verde indica que a lamina esta pronta

### Passo 5: Visualizar a lamina

Clique no botao. Um popover mostra:
- Lista de laminas prontas (com thumbnail)
- Campo de busca manual

Clique na lamina `A2`. O SuperNavi gera um **magic link** (JWT com 5 min de validade) e abre o viewer em nova aba.

### Passo 6: Viewer read-only

O viewer abre diretamente na lamina, sem necessidade de login:
- Zoom, pan e navegacao funcionam normalmente
- Ferramentas de anotacao e medicao ficam **desabilitadas** (modo read-only)
- O link expira apos 5 minutos -- compartilhar a URL nao funciona depois

**Resultado:** Do momento que o patologista abre o exame no PathoWeb ate visualizar a lamina digital, sao **2 cliques e menos de 3 segundos**.
