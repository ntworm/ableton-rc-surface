# Assets Checklist — Ableton RC Bridge

> Tudo que precisa ser gravado/criado visualmente pro lançamento.
> Spec técnica + conteúdo + tempo estimado.
> Marque `[x]` conforme for produzindo.

## Resumo rápido

| categoria | qtd | prioridade | tempo estimado |
|---|---|---|---|
| vídeos longos (tutorial + performance) | 3 | 🔴 alta | ~3h |
| vídeo demo curto (master 60s) | 1 | 🔴 alta | ~2h |
| GIFs (features em loop) | 5 | 🔴 alta | ~1h |
| screenshots phone client | 6 | 🔴 alta | ~30min |
| screenshots Live panel | 3 | 🟡 média | ~30min |
| banner README | 1 | 🟡 média | ~20min |
| logo SVG | 1 | 🟢 opcional | ~30min |
| ícone 240×240 (Product Hunt) | 1 | 🟡 média | ~15min |
| **total estimado** | | | **~8h** |

---

## 🔴 PRIORIDADE ALTA — vídeos

### V1 — Instalação no Windows (você fazendo)

- **arquivo final:** `videos/install-windows.mp4`
- **duração:** 90–120 segundos
- **resolução:** 1920×1080
- **formato:** MP4 h264, < 50 MB
- **codec audio:** AAC, narração em português
- **conteúdo:**
  1. baixar `.ablx` do GitHub Releases
  2. duplo-clique no arquivo
  3. Live oferece "Install extension" → click Install
  4. menu Extensions → Ableton RC Bridge → Show panel
  5. QR aparece
  6. "próximo vídeo: como conectar"
- **tool:** OBS Studio (screen recording)
- **tempo de produção:** 1h (gravação 20min + edição 40min)
- **uso:** README `INSTALL.md`, YouTube, embedded no blog post

### V2 — Abrir o painel + conectar (você fazendo)

- **arquivo final:** `videos/open-panel-connect.mp4`
- **duração:** 60–90 segundos
- **resolução:** 1920×1080
- **formato:** MP4 h264, < 40 MB
- **conteúdo:**
  1. Live aberto com projeto carregado
  2. Extensions → Ableton RC Bridge → Show panel
  3. QR codes aparecem (Performance + Mix)
  4. pegar celular, escanear QR
  5. navegador abre no celular (mostrar tela)
  6. primeiro toque num pad → áudio reage
- **tool:** OBS + celular pra gravar a tela do phone
- **tempo de produção:** 1h
- **uso:** sequência do V1, GitHub README

### V3 — Performance ao vivo (você tocando)

- **arquivo final:** `videos/performance-live.mp4`
- **duração:** 2–3 minutos
- **resolução:** 1920×1080
- **formato:** MP4 h264, < 100 MB
- **conteúdo:**
  1. setup inicial — Live + celular conectado
  2. trocar entre diferentes controles:
     - pads disparando drum rack
     - knobs abrindo filtro
     - XY pad movendo efeito
     - sensor panel (giroscópio modulando synth)
     - snapshots morphando entre presets
  3. mostrar admin dashboard aberto no laptop mostrando os valores em tempo real
- **tool:** OBS + celular filmando o phone
- **tempo de produção:** 1h
- **uso:** YouTube (longo), embed no blog, Twitter thread

### V4 — Demo master 60s (curto)

- **arquivo final:** `videos/demo-60s.mp4`
- **duração:** exatamente 60 segundos (±3s)
- **resolução:** 1920×1080 + versão 1080×1920 vertical (Reels/TikTok)
- **formato:** MP4 h264, < 10 MB
- **conteúdo:** ver `docs/marketing/demo-video-script.md` (script já escrito)
- **tool:** OBS + CapCut ou DaVinci Resolve
- **tempo de produção:** 2h
- **uso:** landing page embed YouTube, GitHub README hero, Twitter thread tweet 1, YouTube Shorts, Instagram Reels, TikTok

---

## 🔴 PRIORIDADE ALTA — GIFs

todos em loop infinito, sem audio, otimizados pra web.

### GIF1 — Pads triggering

- **arquivo:** `gifs/pads-trigger.gif`
- **dimensões:** 600×600 (quadrado, cabe Twitter/Discord)
- **duração:** 4s loop
- **tamanho:** < 2 MB
- **conteúdo:** dedo batendo 4 pads em sequência, áudio de drum rack reagindo (transcrito em WAV separado ou visual feedback)
- **uso:** landing page feature card, README, Twitter thread

### GIF2 — Knobs rotating

- **arquivo:** `gifs/knobs-rotating.gif`
- **dimensões:** 600×600
- **duração:** 3s loop
- **tamanho:** < 2 MB
- **conteúdo:** 2 dedos girando 2 knobs, valor mudando visivelmente
- **uso:** landing page, README

### GIF3 — XY pad em ação

- **arquivo:** `gifs/xy-pad.gif`
- **dimensões:** 600×600
- **duração:** 3s loop
- **tamanho:** < 2 MB
- **conteúdo:** dedo arrastando XY pad, parâmetro visualizando movimento (sintetizador reagindo)
- **uso:** landing page, README

### GIF4 — Sensor panel (giroscópio)

- **arquivo:** `gifs/sensor-gyro.gif`
- **dimensões:** 600×600
- **duração:** 4s loop
- **tamanho:** < 2 MB
- **conteúdo:** celular inclina → parâmetro de synth muda visualmente
- **uso:** landing page sensor card, Twitter thread

### GIF5 — Snapshots morphing

- **arquivo:** `gifs/snapshots-morph.gif`
- **dimensões:** 600×600
- **duração:** 5s loop
- **tamanho:** < 2 MB
- **conteúdo:** admin dashboard mostra 2 snapshots morphando, UI do celular muda simultaneamente
- **uso:** landing page, README

---

## 🔴 PRIORIDADE ALTA — screenshots phone

todos tirados do celular real (não emulador), em portrait, tema dark.

### S1 — Home / Performance view

- **arquivo:** `screenshots/phone-01-home.png`
- **dimensões:** 1080×2400 (iPhone Pro Max res)
- **conteúdo:** home com 12 pads visíveis, modo release ativo
- **uso:** landing page hero, README, Product Hunt gallery

### S2 — Knobs/faders view

- **arquivo:** `screenshots/phone-02-knobs.png`
- **dimensões:** 1080×2400
- **conteúdo:** página de knobs e faders, alguns com valor setado
- **uso:** landing page, README

### S3 — XY pad view

- **arquivo:** `screenshots/phone-03-xy.png`
- **dimensões:** 1080×2400
- **conteúdo:** XY pad centralizado, dedo em posição
- **uso:** landing page, README

### S4 — Sensor panel

- **arquivo:** `screenshots/phone-04-sensors.png`
- **dimensões:** 1080×2400
- **conteúdo:** aba de sensores aberta, gyro/accel/audio visíveis
- **uso:** landing page, README

### S5 — Mix view (v0.4+)

- **arquivo:** `screenshots/phone-05-mix.png`
- **dimensões:** 1080×2400
- **conteúdo:** view de mix com faders de tracks
- **uso:** landing page, README

### S6 — Admin pairing screen

- **arquivo:** `screenshots/phone-06-admin.png`
- **dimensões:** 1080×2400
- **conteúdo:** tela do admin dashboard mostrando clientes conectados + sensor values
- **uso:** README, blog post

---

## 🟡 PRIORIDADE MÉDIA — screenshots Live panel

### S7 — Panel com QR codes

- **arquivo:** `screenshots/live-01-panel-qr.png`
- **dimensões:** 1920×1080
- **conteúdo:** Live 12.4.5+ aberto com painel "Show panel" mostrando os 2 QR codes (Performance + Mix)
- **uso:** landing page hero, README, blog post

### S8 — Extensions menu

- **arquivo:** `screenshots/live-02-extensions-menu.png`
- **dimensões:** 1920×1080
- **conteúdo:** menu Extensions aberto mostrando "Ableton RC Bridge"
- **uso:** INSTALL.md, blog post

### S9 — Admin dashboard no Live

- **arquivo:** `screenshots/live-03-admin.png`
- **dimensões:** 1920×1080
- **conteúdo:** admin dashboard com lista de clientes conectados + sensor streams
- **uso:** README, blog post

---

## 🟡 PRIORIDADE MÉDIA — banner + ícones

### B1 — Banner README

- **arquivo:** `assets/banner-readme-1280x640.png`
- **dimensões:** 1280×640
- **formato:** PNG
- **tamanho:** < 500 KB
- **conteúdo:** branding Ableton RC Bridge, screenshot ou render 3D do celular com Live, gradient purple→teal
- **uso:** topo do README.md, social preview image do GitHub
- **tool:** Figma ou Canva

### B2 — Ícone Product Hunt

- **arquivo:** `assets/icon-240x240.png`
- **dimensões:** 240×240
- **formato:** PNG com fundo transparente
- **tamanho:** < 100 KB
- **conteúdo:** logo RC simplificado, fundo transparente
- **uso:** Product Hunt gallery, ícone GitHub social preview
- **tool:** Figma ou Affinity Designer

---

## 🟢 OPCIONAL — logo

### L1 — Logo SVG vetorial

- **arquivo:** `assets/logo.svg`
- **conteúdo:** símbolo RC minimalista, gradient roxo→teal, versão mono (preto/branco)
- **uso:** landing page brand mark, README badge
- **tool:** Figma ou Inkscape

---

## Convenções

### Nomenclatura de arquivos

- **lowercase**, com hífen: `pads-trigger.gif`
- **sem espaços**, sem acentos, sem caracteres especiais
- **pastas por tipo:** `videos/`, `gifs/`, `screenshots/`, `assets/`

### Onde salvar

```
docs/
├── assets/
│   ├── videos/
│   ├── gifs/
│   ├── screenshots/
│   ├── banner-readme-1280x640.png
│   ├── icon-240x240.png
│   └── logo.svg
```

### Compressão

- vídeos: HandBrake preset "Fast 1080p30" (h264, target ~5 Mbps)
- GIFs: `gifsicle -O3 --lossy=80` ou ezgif.com
- PNGs: `pngquant --quality=80-90`

---

## Ordem de produção recomendada

| ordem | asset | por quê |
|---|---|---|
| 1 | S7 (panel QR) | mais rápido, mostra produto funcionando |
| 2 | S1-S6 (screenshots phone) | base visual pra tudo |
| 3 | V4 (demo 60s) | demanda mais tempo, mas é o asset #1 de marketing |
| 4 | GIF1-5 | derivados das gravações do V4 |
| 5 | V1, V2 (install + connect) | narrados, didáticos |
| 6 | V3 (performance) | mais bonito de fazer por último |
| 7 | B1, B2 (banner + icon) | depois de ter tudo pronto |

---

## Antes de gravar

- [ ] v0.4.17+ estável, instalado em Live
- [ ] celular carregado, Wi-Fi conectado
- [ ] tema dark do celular ativo
- [ ] Live theme dark ou medium
- [ ] projeto Ableton de demo carregado (drum rack + synth com macro visível)
- [ ] OBS configurado: 1920×1080, 30fps, bitrate ~8000 kbps
- [ ] microfone pra narração (V1, V2, V3)
- [ ] celular extra pra filmar phone screen (V1, V2, V3, GIFs)

---

## Direitos

todos os assets produzidos são MIT (mesma licença do projeto).
se usar música de fundo, confirmar licença royalty-free (CC0 ou compatível).
se mostrar projetos Ableton com samples de terceiros, considerar substituir por samples royalty-free.