# Instalacao Edge na Clinica (MOTIC)

Guia de instalacao do SuperNavi Edge em maquinas com scanner MOTIC.

## Pre-requisitos

- Node.js 20+ (para o `setup.js`)
- Docker + Docker Compose v2
- Scanner MOTIC configurado e salvando laminas em pasta local

## 1. Clonar e entrar no diretorio

```bash
git clone <repo> supernavi
cd supernavi/supernavi_edge
```

## 2. Executar setup

### Modo automatico (detecta pasta do MOTIC)

```bash
node setup.js
```

O wizard:
1. Escaneia pastas conhecidas do MOTIC (`/opt/motic/scans`, `/home/motic/scans`, etc.)
2. Pontua cada candidato (existencia, arquivos WSI, arquivos recentes)
3. Sugere a melhor opcao — confirme com Enter
4. Pergunta tempo de estabilidade do arquivo (padrao: 15s)
5. Gera `config/edge-config.json` e `docker-compose.override.yml`

### Modo headless (CI/automacao)

```bash
node setup.js --auto
```

Aceita automaticamente o melhor candidato (score >= 50). Falha se nada for encontrado.

### Modo manual (pasta especifica)

```bash
node setup.js --dir /caminho/para/laminas
```

### Reset completo

```bash
node setup.js --reset
```

Remove `config/edge-config.json` e `docker-compose.override.yml`.

## 3. Subir containers

```bash
docker compose up -d --build
```

O `docker-compose.override.yml` gerado pelo setup monta a pasta do scanner como `/data/inbox` dentro do container.

## 4. Verificar status

```bash
# Health check
curl -s localhost:3000/v1/health | jq .

# Resposta esperada:
# {
#   "status": "ok",
#   "watcher": { "state": "running", "ingestDir": "/data/inbox" },
#   "config": { "loaded": true, "source": "auto-detect", "scannerType": "motic" }
# }
```

## 5. Endpoints administrativos

### Ver config atual

```bash
curl -s localhost:3000/v1/admin/config | jq .
```

### Alterar config via HTTP

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"stableSeconds": 10}' \
  localhost:3000/v1/admin/config | jq .
```

> Se `slidesDirHost` for alterado, e necessario reiniciar os containers para aplicar o novo volume mount.

### Detectar scanners (sem aplicar)

```bash
curl -s localhost:3000/v1/admin/scanner/detect | jq .
```

## Configuracao (`config/edge-config.json`)

| Campo | Tipo | Default | Descricao |
|-------|------|---------|-----------|
| `version` | number | `1` | Versao do schema |
| `source` | string | `"defaults"` | Quem gerou: `auto-detect`, `wizard-cli`, `wizard-http`, `manual` |
| `scanner.type` | string | `"unknown"` | Tipo de scanner: `motic`, `hamamatsu`, `leica`, `generic` |
| `slidesDirHost` | string | `"./data/inbox"` | Caminho no HOST para a pasta de laminas |
| `slidesDirContainer` | string | `"/data/inbox"` | Caminho DENTRO do container |
| `rawDirContainer` | string | `"/data/raw"` | Pasta para arquivos processados |
| `derivedDirContainer` | string | `"/data/derived"` | Pasta para tiles derivados |
| `stableSeconds` | number | `15` | Segundos para esperar estabilidade do arquivo |
| `caseBaseRegex` | string | `"^(AP\\d{6,12})"` | Regex para extrair case base do nome do arquivo |

## Troubleshooting

### Status `needs_config`

```
"status": "needs_config"
"watcher": { "state": "needs_config", "error": "Inbox directory not accessible: /data/inbox" }
```

**Causa:** A pasta montada como `/data/inbox` nao esta acessivel.

**Solucao:**
1. Verificar se o scanner esta ligado e a pasta existe no host
2. Rodar `node setup.js` novamente para reconfigurar
3. `docker compose down && docker compose up -d`

### Status `dir_inaccessible`

O watcher estava funcionando mas a pasta ficou inacessivel (ex: HD externo desconectado, rede caiu).

O watcher verifica a cada 30s e volta automaticamente para `running` quando a pasta ficar acessivel novamente.

### Arquivos nao estao sendo processados

1. Verificar formato suportado: `.svs`, `.tif`, `.tiff`, `.ndpi`, `.mrxs`, `.jpg`, `.jpeg`, `.png`
2. Verificar logs: `docker compose logs -f api`
3. Verificar se o arquivo foi copiado completamente (aguardar `stableSeconds`)
4. Verificar permissoes: o container precisa ler a pasta montada

### Reset completo

```bash
node setup.js --reset
docker compose down -v
rm -rf ./data/raw/* ./data/derived/*
docker compose up -d --build
```

## Pastas de deteccao automatica

O setup verifica as seguintes pastas (em ordem de prioridade):

**MOTIC (Linux):**
- `/opt/motic/scans` (score: 100)
- `/opt/motic/slides` (score: 95)
- `/home/motic/scans` (score: 90)
- `/motic` (score: 85)

**MOTIC (Windows):**
- `C:\Motic\Scans` (score: 100)
- `C:\Motic\SlideScanner` (score: 95)
- `D:\Motic\Scans` (score: 90)
- `C:\MoticImageExport` (score: 85)

**Outros scanners:**
- Hamamatsu: `C:\NDP.view2\Images`, `/opt/hamamatsu/ndpi`
- Leica/Aperio: `C:\Aperio\Images`, `/opt/aperio/images`
- Generico: `/data/scanner`, `/mnt/scanner`, `/srv/scanner`

Cada candidato recebe bonus por:
- Conter arquivos WSI (+20 por extensao, max 40)
- Ter arquivos recentes (ultimos 30 dias) (+10)
- Nao estar vazio (+5)
