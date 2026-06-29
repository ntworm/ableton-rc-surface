# Demo Video Script — Ableton RC Bridge (60 seconds)

> Rascunho. Gravar quando v0.4.17 estiver estável e os assets visuais
> estiverem prontos. Nunca postar antes do freeze do código.

## formato

- duração: 60 segundos (tolerância ±3s)
- resolução: 1920×1080 (ou 1080×1920 se for vertical pra TikTok/Reels)
- áudio: música de fundo baixinha (royalty-free, lo-fi chill 70-80 BPM)
- legendas: hardcoded em inglês, estilo clean

## shot list

```
[0:00 - 0:03]  HERO TEXT
               tela preta, texto fade-in:
               "Ableton RC Bridge"
               subtítulo: "phone as MIDI controller"
               bg: leve gradient purple→blue

[0:03 - 0:08]  INSTALAÇÃO
               screen recording Live 12.4.5+ Suite:
               1. duplo-clique no .ablx
               2. Live mostra "Install extension"
               3. clica Install
               4. menu Extensions → "Ableton RC Bridge" → "Show panel"
               texto overlay: "Install in 10 seconds"

[0:08 - 0:13]  QR PAIRING
               panel aparece com QR code
               mão entra no frame, celular Android/iOS scanneia
               browser abre no celular com a UI cheia
               texto overlay: "Scan. Play."

[0:13 - 0:25] PERFORMANCE — PERFORMANCE PAD + KNOBS + XY
               screen recording celular:
               - dedo bate nos 12 pads (audio de drum rack reagindo)
               - 2 dedos nos knobs, valores mudando
               - XY pad move, filtro abre/fecha (sintetizador)
               - ribbon expression sendo arrastado
               troca rápida entre features

[0:25 - 0:35] SENSOR PANEL
               screen recording celular:
               - aba "Sensors" aberta
               - celular inclina (giroscópio) → parâmetro de synth muda
               - audio detector: bate palma → dispara sample
               - câmera ativa: mão reconhecida (MediaPipe) → efeito visual
               texto overlay: "Your phone is the controller"

[0:35 - 0:45] ADMIN DASHBOARD + SNAPSHOTS
               screen recording desktop:
               - 2 clientes conectados (perf + admin) no dashboard
               - admin mostra live values dos sensores
               - clica em 3 snapshots diferentes, UI do celular muda
               - morph entre 2 snapshots (2D vector morph pad)
               texto overlay: "Performance + admin, simultaneously"

[0:45 - 0:55] FREE / OPEN SOURCE / MIT
               tela com 3 cards lado a lado:
               [FREE]      [OPEN SOURCE]    [MIT LICENSE]
               ícone       ícone github     ícone cert
               "$0"        "github.com/.."  "do what you want"
               background: gradient suave

[0:55 - 1:00] CTA FECHAMENTO
               tela final:
               "Ableton RC Bridge"
               "github.com/worm/ableton-rc-bridge"
               "Donations welcome"
               logo + URL do Gumroad (pequeno)
               fade-out
```

## tools pra gravar/editar

- **OBS Studio** (grátis) — screen recording
- **CapCut** ou **DaVinci Resolve** (grátis) — edição
- **smartphone gimbal** (opcional) — pra cenas externas

## takes alternativos (B-roll)

- close-up de mão tocando phone screen
- Live rodando no fundo enquanto celular toca
- split-screen: tela Live + tela phone lado a lado
- terminal mostrando `npm run build` rodando (dev vibe)

## versões alternativas

| versão | duração | resolução | uso |
|---|---|---|---|
| master | 60s | 1920×1080 | YouTube + landing |
| vertical | 60s | 1080×1920 | TikTok + Reels |
| curto | 30s | 1920×1080 | Twitter teaser |
| estendido | 5min | 1920×1080 | YouTube tutorial |

## música de fundo

sugestões royalty-free (verificar licença CC0):

- lo-fi chill 70-80 BPM
- progressive electronic 120-128 BPM
- ambient pad

**volume:** -18dB a -12dB (não competir com audio do app)

## CTA final

duas opções:

**A (pedir doação):**
"Like it? Donate: gumroad.com/worm/ableton-rc-bridge"

**B (pedir star):**
"Star it: github.com/worm/ableton-rc-bridge"

**C (neutro):**
"Built with the Ableton Extensions SDK"

minha recomendação: **A** pra video curto (landing/Reels), **B** pra
video longo (YouTube tutorial).

---

## checklist pré-gravação

- [ ] v0.4.17 estável, instalado em Live
- [ ] celular Android ou iOS carregado, Wi-Fi conectado
- [ ] tema escuro do celular ativo (visual mais clean)
- [ ] Live theme: dark ou medium
- [ ] projeto Ableton de demo carregado (algum drum rack + synth com macro)
- [ ] OBS configurado: 1920×1080, 30fps, bitrate ~8000 kbps
- [ ] microfone pra narração (opcional, mas recomendado)
- [ ] celular pra gravar takes externos (se usar B-roll)