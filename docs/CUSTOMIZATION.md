# Customization Guide

> Como customizar a interface do celular, mudar cores, adicionar/remover
> parâmetros MIDI, ajustar a contagem de controles. Pensado pra ser lido
> por humanos **e** por agentes de IA que vão modificar o código.

> Última atualização: junho de 2026.

---

## Índice

- [Visão geral da arquitetura](#visão-geral-da-arquitetura)
- [Setup de desenvolvimento](#setup-de-desenvolvimento)
- [Customizando cores e tema](#customizando-cores-e-tema)
- [Customizando layout (página do celular)](#customizando-layout-página-do-celular)
- [Adicionando ou removendo controles MIDI](#adicionando-ou-removendo-controles-midi)
- [Adicionando/removendo sensores](#adicionando-removendo-sensores)
- [Customizando mapeamento MIDI padrão](#customizando-mapeamento-midi-padrão)
- [Customizando snapshots e morph](#customizando-snapshots-e-morph)
- [Customizando o admin dashboard](#customizando-o-admin-dashboard)
- [Testando mudanças](#testando-mudanças)
- [Empacotando nova versão](#empacotando-nova-versão)

---

## Visão geral da arquitetura

```
┌─────────────────────────────────────────────────────────┐
│  Ableton Live (extensão)                                │
│  src/extension.ts  ← entry, ~3500 linhas                │
│  src/server/       ← HTTP + WS + cert                   │
│  src/live/         ← state + mappings + snapshots       │
│  src/util/         ← helpers                            │
└─────────────────────────────────────────────────────────┘
            ↕ WebSocket + HTTPS
┌─────────────────────────────────────────────────────────┐
│  Phone client (browser)                                 │
│  static/phone-v3/                                       │
│    index.html       ← estrutura DOM                     │
│    style.css        ← tema, cores, layout               │
│    app.js           ← entry, ciclo de vida               │
│    controls.js      ← pads/knobs/faders/xy/ribbons      │
│    mode-engine.js   ← lógica dos 4 modos de pad         │
│    audio-processor.js  ← YIN pitch + RMS + onset        │
│    vision-processor.js ← MediaPipe Hands wrapper        │
│    sensor-fusion.js ← Madgwick IMU                      │
│    sensor-denoise.js, sensor-stability.js ← filtros      │
└─────────────────────────────────────────────────────────┘
            ↕ (mesma WS, porta diferente)
┌─────────────────────────────────────────────────────────┐
│  Admin dashboard (browser)                              │
│  static/admin/                                          │
│    index.html, mappings.html, app.js, mappings-core.js  │
└─────────────────────────────────────────────────────────┘
```

**regra de ouro:** o phone client é puro HTML/CSS/JS, sem build step.
qualquer mudança em `static/phone-v3/` aparece instantaneamente
quando você recarrega a página no celular.

---

## Setup de desenvolvimento

```bash
# 1. clonar
git clone https://github.com/worm/ableton-rc-bridge.git
cd ableton-rc-bridge

# 2. instalar deps (Node 24.14.1+, ver .nvmrc)
nvm use            # se tiver nvm
npm install

# 3. build (sem minify, pra dev)
npm run build

# 4. rodar em Live
npm start
```

**dica:** pra ver mudanças no phone client em tempo real:

1. deixe `npm start` rodando
2. edite arquivos em `static/phone-v3/`
3. o build copia automaticamente pra `dist/static/phone-v3/`
4. **recarregue a página no celular** (pull-to-refresh ou fechar/reabrir
   a aba)

se a mudança for no `extension.ts`, reinicie o Live.

---

## Customizando cores e tema

**arquivo:** `static/phone-v3/style.css` (~922 linhas)

### cores principais

```css
/* fundo geral */
body { background: #08080a; color: #f5f5f7; }

/* azul de destaque (ativo, conectado) */
.tab.on { background: #0a84ff; border-color: #0a84ff; color: #fff; }

/* verde de status OK */
.status.connected { color: #30d158; border-color: #30d158; }

/* vermelho de erro/warning */
.danger { border-color: #ff453a; color: #ff453a; }

/* cinza secundário */
.muted { color: #a1a1a6; }

/* cores de valores ao vivo */
.ablt-val.bpm       { color: #ff9f0a; }   /* laranja */
.ablt-val.playhead  { color: #0a84ff; }   /* azul */
.ablt-val.time      { color: #bf5af2; }   /* roxo */
.ablt-val.scale     { color: #5ac8fa; }   /* ciano */
```

### paleta alternativa (exemplo)

pra trocar pro tema "synthwave":

```css
body { background: #1a0033; color: #ff6ec7; }
.tab.on { background: #ff006e; border-color: #ff006e; color: #fff; }
.status.connected { color: #00f5d4; border-color: #00f5d4; }
.ablt-val.bpm { color: #ffbe0b; }
```

faça search-replace nesses valores hex no `style.css`. como as cores
estão hardcoded (não usam CSS variables), é mais simples editar
diretamente.

### criando tema dinâmico com CSS variables (refactor opcional)

se quiser suportar múltiplos temas:

```css
:root {
  --bg: #08080a;
  --fg: #f5f5f7;
  --accent: #0a84ff;
  --ok: #30d158;
  --danger: #ff453a;
  --muted: #a1a1a6;
}

body { background: var(--bg); color: var(--fg); }
.tab.on { background: var(--accent); }
```

e adicionar troca de tema via `body.theme-synthwave` etc.

---

## Customizando layout (página do celular)

**arquivo:** `static/phone-v3/index.html` (~479 linhas)

### estrutura DOM

o HTML é dividido em "tabs" (abas):

- **performance** — pads, knobs, faders, ribbons, XY pads
- **mix** — mixer view (v0.4+)
- **sensors** — gyro/accel/light/audio/camera
- **admin** — dashboard de monitoramento

cada tab é um container separado. pra mudar layout:

1. editar a estrutura HTML dentro de `<div id="tab-X" class="tab-content">`
2. adicionar novos elementos
3. estilizar em `style.css`
4. conectar lógica em `app.js` ou `controls.js`

### exemplo: adicionar um botão "panic"

```html
<!-- dentro de tab-performance, onde quiser -->
<button id="panic-btn" class="panic-btn">PANIC</button>
```

```css
/* em style.css */
.panic-btn {
  width: 100%;
  padding: 16px;
  background: #ff453a;
  color: #fff;
  border: none;
  border-radius: 12px;
  font-weight: 800;
  font-size: 18px;
}
```

```javascript
// em app.js, dentro do setup inicial
document.getElementById('panic-btn').addEventListener('click', () => {
  // enviar mensagem pro Live via WS
  ws.send(JSON.stringify({ type: 'all-notes-off' }));
});
```

(você precisa implementar o handler `'all-notes-off'` no servidor
também, em `src/server/ws.ts` ou similar.)

---

## Adicionando ou removendo controles MIDI

### contagem atual (padrão)

| controle | qtd | tipo MIDI |
|---|---|---|
| pads | 12 | note on/off |
| knobs | 8 | CC (1-8) |
| faders | 12 (8 + 4 bipolar) | CC (9-20) |
| ribbons | 4 | pitch bend / CC |
| XY pads | 2 | CC x2 |

esses números estão em vários arquivos. pra mudar, você precisa
atualizar em **todos**:

1. `static/phone-v3/index.html` — estrutura HTML
2. `static/phone-v3/controls.js` — lógica de interação + emissão MIDI
3. `static/phone-v3/style.css` — grid layout
4. `src/live/mappings.ts` — channel/number allocation
5. `src/server/ws.ts` — protocolo (se adicionar novos tipos)
6. `README.md` — atualizar specs
7. `docs/FAQ.md` — atualizar resposta sobre "quantos controles"

### exemplo: adicionar um knob (9º)

**1. HTML** (`index.html`):
```html
<div class="knob-grid">
  <!-- knobs existentes 1-8 -->
  <div class="knob" data-knob-id="9" data-cc="9">9</div>
</div>
```

**2. JS** (`controls.js`):
```javascript
// no array de knobs setup
const KNOB_COUNT = 9;  // era 8
// ... loop que gera os 9 knobs
```

**3. CSS** (`style.css`):
ajustar `grid-template-columns` se necessário pro novo knob caber.

**4. server** (`src/live/mappings.ts`):
adicionar entry `knob9: { channel: 1, cc: 9 }`.

**5. teste:**
```bash
npm test
```

### removendo controle

mesmo processo, mas diminuindo a contagem e removendo entries do array.

---

## Adicionando/removendo sensores

**arquivo:** `static/phone-v3/sensor-fusion.js`, `audio-processor.js`, `vision-processor.js`

### sensores atuais

- **gyroscope** (`DeviceOrientationEvent`)
- **accelerometer** (`DeviceMotionEvent`)
- **ambient light** (`AmbientLightSensor`)
- **audio pitch/RMS/onset** (microfone + AudioWorklet)
- **camera hand-tracking** (MediaPipe Hands, via CDN)

### exemplo: adicionar magnetômetro (bússola)

```javascript
// em sensor-fusion.js
async function initMagnetometer() {
  if ('Magnetometer' in window) {
    try {
      const sensor = new Magnetometer({ frequency: 30 });
      sensor.addEventListener('reading', () => {
        const { x, y, z } = sensor;
        // emitir como CC pro Live
        sendCC({
          channel: 1,
          cc: 100,  // CC number novo pro magnetometer
          value: normalize(x, -50, 50)
        });
      });
      sensor.start();
    } catch (e) {
      console.warn('Magnetometer not available', e);
    }
  }
}
```

depois adicionar botão "Magnetometer" na aba Sensors (HTML) e estilizar.

---

## Customizando mapeamento MIDI padrão

**arquivo:** `src/live/mappings.ts` (~904 linhas)

### estrutura típica

```typescript
export const DEFAULT_MAPPINGS = {
  pads: {
    1:  { channel: 1, note: 36 },  // kick
    2:  { channel: 1, note: 38 },  // snare
    // ...
  },
  knobs: {
    1: { channel: 1, cc: 1 },
    2: { channel: 1, cc: 2 },
    // ...
  },
  // ...
};
```

### exemplo: trocar padrão de notas dos pads

```typescript
// mudar pra escala cromática
pads: {
  1: { channel: 1, note: 60 },  // C4
  2: { channel: 1, note: 61 },  // C#4
  3: { channel: 1, note: 62 },  // D4
  // ...
}
```

### exemplo: knobs no channel 2

```typescript
knobs: {
  1: { channel: 2, cc: 1 },
  // ...
}
```

**lembre-se:** o usuário pode remapear qualquer controle via
mapeamento MIDI dentro do Live (clicando no knob do celular, depois no
parâmetro do Live). o default é só o ponto de partida.

---

## Customizando snapshots e morph

**arquivos:** `src/live/snapshots.ts` (~556 linhas), UI em
`static/phone-v3/app.js`

### quantos snapshots?

default é **8 slots** (A-H). pra mudar:

**`src/live/snapshots.ts`:**
```typescript
export const SNAPSHOT_COUNT = 8;  // mudar aqui
```

**HTML** (`index.html`):
```html
<div class="snapshot-strip">
  <button class="snap" data-snap="A">A</button>
  <button class="snap" data-snap="B">B</button>
  <!-- ... até H -->
</div>
```

**JS** (`controls.js` ou `app.js`):
ajustar loop de geração.

### morph 2D

o morph entre 2 snapshots é feito via "vector morph pad" — um XY
pad onde X = blend entre snap A e snap B (0 = A, 1 = B), Y = blend
entre snap C e snap D.

pra customizar:

```javascript
// em controls.js
const MORPH_AXES = {
  x: { from: 'A', to: 'B' },
  y: { from: 'C', to: 'D' },
};
```

---

## Customizando o admin dashboard

**arquivos:** `static/admin/` (4 arquivos, ~2000 linhas total)

- `index.html` — entry
- `mappings.html` — view de mapeamentos
- `app.js` — lógica principal
- `mappings-core.js` — edição de mappings

### adicionar nova seção

1. adicionar HTML em `index.html`
2. estilizar em `style.css` (admin tem style próprio)
3. lógica em `app.js`

### exemplo: adicionar log de eventos

```html
<section class="event-log">
  <h3>Event log</h3>
  <div id="event-list"></div>
</section>
```

```javascript
// em app.js
function logEvent(event) {
  const list = document.getElementById('event-list');
  const item = document.createElement('div');
  item.textContent = `[${new Date().toISOString()}] ${event.type}`;
  list.prepend(item);
  // manter últimos 50
  while (list.children.length > 50) list.removeChild(list.lastChild);
}
```

---

## Testando mudanças

### testes automatizados

```bash
npm test
```

cobre:
- `mode-engine.test.mjs` — 4 modos de pad
- `audio-processor.test.mjs` — YIN pitch, RMS, onset
- `gestures-touch.test.mjs` — multi-touch
- `sensor-fusion.test.mjs` — Madgwick IMU
- `sensor-denoise.test.mjs`, `sensor-stability.test.mjs`
- `vision-processor.test.mjs` — MediaPipe wrapper
- `haptics-wakelock.test.mjs`
- `battery-diagnostics.test.mjs`

### teste manual

1. `npm start`
2. abrir Live 12.4.5+ Suite
3. Extensions → Ableton RC Bridge → Show panel
4. escanear QR com celular
5. testar cada controle que você mudou

### teste cross-browser

- Chrome / Edge / Brave no Android
- Safari no iOS 15.4+

**gotchas iOS Safari:**
- sem `navigator.vibrate`
- sem Wake Lock
- cert self-signed precisa bypass manual (Settings → Safari → Advanced →
  HTTPS)

---

## Empacotando nova versão

```bash
# 1. atualizar versão em manifest.json
# "version": "0.4.21"

# 2. atualizar CHANGELOG.md
# adicionar entry na seção [Unreleased] ou criar [0.4.21]

# 3. build de produção (minified)
npm run build:prod

# 4. gerar .ablx
npm run package

# saída: Ableton-RC-Bridge-0.4.21.ablx
```

antes de distribuir, verifique:

```bash
unzip -l Ableton-RC-Bridge-0.4.21.ablx
```

deve conter:
- `manifest.json`
- `dist/extension.js`
- `dist/static/phone-v3/...`
- `dist/static/admin/...`

**NÃO** deve conter:
- `dist/static/.certs/...` (cert privado)
- `dist/extension.js.map` em produção (sourcemap)

---

## Dicas pra agentes de IA

se você é um agente modificando este projeto:

1. **sempre rode `npm test`** depois de mudanças — se quebrar, reverta
2. **não commite em `main`** — abra PR
3. **não mexa em `src/extension.ts`** sem entender o refactor em
   andamento (criar módulos em `src/server/`, `src/live/`, `src/util/` é
   preferível)
4. **cores estão hardcoded** no `style.css` — pra refatorar pra CSS
   variables, faça em PR separado
5. **números de controles (12, 8, 4, 2)** estão espalhados em vários
   arquivos — mudar exige sincronizar
6. **WebSocket protocol** é JSON simples, documentado no README — se
   adicionar tipo novo, atualize README + FAQ

---

## Ver também

- [`INSTALL.md`](./INSTALL.md) — como instalar e rodar
- [`FAQ.md`](./FAQ.md) — perguntas frequentes
- [`SECURITY.md`](./SECURITY.md) — modelo de ameaça e design do cert
- [`PRIVACY.md`](./PRIVACY.md) — política de privacidade
- [README](../../README.md) — overview