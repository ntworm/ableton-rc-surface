# bug report — testes de integração do v0.4.14 (encontrados em mock)

**autor**: broc (Hermes Agent, profile `broc`)
**data**: 2026-06-29
**método**: subi um mock server Node (`scripts/mock-server.mjs`) que serve HTTP + WebSocket simulando `extension.ts`, com todas as pages do projeto, e testei cada uma com playwright + sim-phone (`scripts/sim-phone.mjs`) mandando dados contínuos
**commits testados**: `4cbb66c` (v0.4.14) + worktree atual (mudanças locais não commitadas no `static/phone-v3/index.html` que reverteram paths `/static/...` para `style.css`)

---

## bugs encontrados

### 🐛 bug #1 — panel "Mappings" tab renderiza lista vazia + erro JS

**severidade**: ALTA (UX quebrada no produto principal)

**sintoma**:
- usuário clica no tab "Mappings" no panel do Live
- console: `TypeError: Cannot convert undefined or null to object at Object.entries(<anonymous>) at window.renderMappingsTab (mappings.js:9:10)`
- a lista de controls não aparece (fica com placeholder "Select a control to view details")

**root cause**:
- `static/panel/mappings.js:9` faz `Object.entries(window.allControlsGrouped).forEach(...)`
- mas `static/panel/app.js:58` declara `const allControlsGrouped = {...}` — **local, nunca exposto pro `window`**
- o `mappings.js` foi criado (fase 1 — DRY) esperando que `allControlsGrouped` estivesse no `window`, mas o `app.js` não foi atualizado pra expor

**evidência**:
```javascript
// static/panel/app.js:58 — local
const allControlsGrouped = {
  SENSORS: [...],
  AUDIO: [...],
  // ...
};

// static/panel/mappings.js:9 — tenta acessar window
Object.entries(window.allControlsGrouped).forEach(([groupName, controls]) => { ... });
```

**fix proposto** (escolher 1):
- (A) mudar `app.js:58` pra `window.allControlsGrouped = {...}`
- (B) passar `allControlsGrouped` como argumento pra `window.renderMappingsTab` em vez de ler do `window`
- (C) mover `allControlsGrouped` pra `static/panel/mappings.js` mesmo (co-localizar com quem usa)

**recomendo (A)** — minimal change, sem refactor.

---

### 🐛 bug #2 — Mappings detail panel mostra `0.000` fixo sem selected control

**severidade**: BAIXA (cosmético, mas expõe estado quebrado do #1)

**sintoma**:
- quando tab Mappings carrega com `selectedControl = null`, o detail panel mostra `<div class="map-live-value">0.000</div>` fixo
- deveria mostrar "Select a control" ou estar vazio

**root cause**:
- o detail panel não checa se `selectedControl` é null antes de renderizar o valor

**fix proposto**: gate o `map-live-value` dentro de `if (selectedControl)` no `renderMappingDetail()`

---

### 🐛 bug #3 — paths `/static/...` quebram mock server (não bug do produto, mas sintoma)

**severidade**: BAIXA (cosmético para mock, mas indica que o build do outro agent não foi testado fora do Live)

**sintoma**:
- `static/phone-v3/index.html` (no HEAD do master) tem `<link href="/static/phone-v3/style.css">` (path absoluto)
- o source worktree local foi mudado pra `href="style.css"` (relativo) mas **o dist/ ainda tem o absoluto**
- qualquer ambiente que não sirva em `/static/...` (incluindo mock ou ngrok) quebra

**evidência**:
```bash
# git HEAD
$ git show HEAD:static/phone-v3/index.html | grep style.css
<link rel="stylesheet" href="/static/phone-v3/style.css">

# worktree (modificado)
$ head -12 static/phone-v3/index.html | tail -1
<link rel="stylesheet" href="style.css">
```

**root cause**: alguém (provavelmente o outro agent que fez v0.4.14) mudou localmente, rebuildou (que copia static/ → dist/static/), mas não comitou. worktree e dist estão dessincronizados.

**fix proposto**:
- (A) commitar a versão `style.css` (relativo) do worktree
- (B) ou commitar a versão `/static/...` (absoluto) do HEAD
- **recomendo (A)** — paths relativos são portáteis, funcionam no Live (que roteia `/static/`) e em qualquer outro lugar
- **ação imediata**: rebuildar o `dist/` pra refletir o worktree

---

### 🐛 bug #4 — Mappings "starter templates" não persistem (limitação do mock, não do app)

**severidade**: N/A (limitação do mock server stateless)

**sintoma**:
- user clica em "Load Template" → DJ Controller, confirma
- modal fecha, Mappings count = 6 ✅
- reload da página → Mappings count = 0 ❌
- mappings perdidos

**root cause**:
- o mock server mantém `mappings` em memória (`const mockState = { mappings: new Map() }`)
- não tem `loadMappings`/`saveMappings` (que no `extension.ts` real persiste em `mappingsFilePath`)

**fix proposto** (se for importante pro mock): persistir `mappings` em arquivo JSON local em `scripts/.mock-mappings.json` e recarregar no startup. **mas não é prioridade** — o teste é pra confirmar UI, não persistência.

---

## ✅ coisas que funcionam

validei o que **passa** com o mock + sim-phone:

| feature | status | evidência |
|---|---|---|
| panel Connect tab | ✅ | QRs renderizam (2 SVG via David Shim qrcode.js) |
| 12 sensor cells no dashboard | ✅ | todos com `inactive: false` quando sim-phone manda data |
| Audio RMS | ✅ | 0.40 típico |
| Audio Pitch | ✅ | 440 |
| Yaw (Alpha) | ✅ | rotaciona (226, etc) |
| Yaw (Beta) | ✅ | ~24 |
| Roll (Gamma) | ✅ | ~28 |
| Sensors Pinch (vision.hand) | ✅ | ativa cell 12 |
| Mappings "Load Template" modal | ✅ | 4 templates aparecem, click → confirm → mappings criados |
| Mappings count badge | ✅ | mostra "6" depois de DJ Controller |
| admin mappings (mappings.html) | ✅ | 82 rows renderizadas, live values atualizando a cada 100ms, renderControls() chamado 29x em 3s |
| admin mappings "active-activity" class | ✅ | controla tem `active: true` quando há live value |
| Inter tab | ✅ | IPs, protocol, port, cert tudo correto |
| WebSocket server (/ws, /admin/ws) | ✅ | ambas conectam, recebem `client_update` broadcasts |
| mjs MIME type | ✅ | depois do fix no mock (`application/javascript` no `.mjs`) |
| phone-v3 page load | ✅ | 0 errors, 17 body children, 12 pads no grid |
| mix view page load | ✅ | 0 errors, view-loading → view-tracks (estrutura pronta) |

---

## 📊 resumo executivo

| categoria | count |
|---|---|
| bugs altos | 1 (Mappings tab quebrada) |
| bugs baixos | 2 (detail panel, paths) |
| bugs mock-only | 1 (não persistência) |
| features funcionando | 15+ validadas |

**bloqueador pro user**: bug #1 (Mappings tab do panel fica vazia). precisa fix antes de v0.4.15.

**recomendação**:
1. fix bug #1: adicionar `window.` no `app.js:58` ou mover o array
2. fix bug #3: commitar o worktree (paths relativos) + rebuildar
3. fix bug #2: gate `map-live-value` no `if (selectedControl)`
4. ship v0.4.15 com esses 3 fixes
5. fases 7-15 do prompt podem seguir (não dependem desses bugs)

---

## arquivos úteis criados nesta sessão

- `scripts/mock-server.mjs` — HTTP+WS mock que simula extension.ts (com symlinks `/static/...` aliases)
- `scripts/sim-phone.mjs` — simula cliente phone mandando data contínua no formato correto
- `docs/BUG-REPORT-v0.4.14-mock-tests.md` — este reporte

esses scripts são **úteis pra futuros testes de regressão** e dev. considerar commitar.

---

## como reproduzir

```bash
# 1. build
cd "C:\Users\Usuario\repos\ableton-extensions\source-repos\ableton-rc-extension"
npm run build:prod

# 2. sobe mock server
node scripts/mock-server.mjs

# 3. simula cliente phone (outro terminal)
node scripts/sim-phone.mjs

# 4. abre no browser
# panel: http://127.0.0.1:8080/static/panel/index.html
# admin: http://127.0.0.1:8080/static/admin/mappings.html
# mix:   http://127.0.0.1:8080/static/mix/index.html
# phone: http://127.0.0.1:8080/static/phone-v3/index.html
```

mock console output esperado:
```
[mock] created symlink phone-v3 -> static/phone-v3
[mock] created symlink panel -> static/panel
[mock] created symlink admin -> static/admin
[mock] created symlink mix -> static/mix
[mock] HTTP+WS server running at http://127.0.0.1:8080
```

---

**contato**: este reporte foi gerado pelo agente broc, profile `broc`, do Hermes Agent rodando no VPS. o operador (worm) pode ser contactado via Telegram pelo username dele.
