# Ableton Discord — Mensagem pro canal `#extensions`

> Rascunho. Adaptar antes de postar. Nunca postar antes do release
> oficial no GitHub.

## mensagem principal

```
Hey 👋 I've been building a sensor-aware phone controller for Live
12.4.5+ using the new Extensions SDK. It's called Ableton RC Bridge
and it's open-source / MIT.

What makes it different from existing solutions:
- Browser-based, no app install on the phone
- Per-install HTTPS cert (so camera/mic APIs work without a shared
  private key)
- Sensor fusion (gyro + accel + light + audio + camera) as
  first-class input
- Two simultaneous clients (performance + admin)
- MIT, free, donations welcome but never required

What you get:
- 12 pads (4 modes), 8 knobs, 12 faders, 4 ribbons, 2 XY pads
- Sensor panel with audio pitch/RMS/onset, camera hand-tracking
- 8 snapshots with 2D morph
- 30 Hz WebSocket, sub-50ms latency

Demo (60s): [YouTube link]
Source + releases: https://github.com/worm/ableton-rc-bridge
Donations: https://worm.gumroad.com/l/ableton-rc-bridge

Would love feedback from anyone testing it with the Extensions SDK
beta. Happy to swap build tips / report bugs upstream.

A few specific things I'd love to hear about:
1. How are you handling the Secure Context requirement for media APIs?
2. Are you also generating per-install certs or using something else?
3. What's your approach for state sync — full snapshots or deltas?
```

## variações

### versão resumida (se o canal preferir mensagens curtas)

```
Built a free, MIT-licensed phone controller for Live 12.4.5+ using
the Extensions SDK. Browser-based, sensor-aware, sub-50ms latency.

Source: github.com/worm/ableton-rc-bridge
Demo: [YouTube link]

Happy to swap notes on the SDK.
```

### versão "looking for testers" (pedir feedback específico)

```
Looking for 3-5 people to test v0.4.17 before I do the public release.

What's in it:
- Phone as MIDI controller, browser-based, no install
- Sensor fusion (gyro/accel/audio/camera) as inputs
- Per-install HTTPS cert for media APIs
- Admin dashboard + performance client

What I want feedback on:
- Cert warnings on iOS Safari — too noisy?
- WebSocket message format — too verbose?
- Sensor panel UX — clear enough?
- Anything else broken

Drop a 🎛️ if interested and I'll DM you the GitHub link.
```

## regras do Discord Ableton

- [ ] **ler o canal `#extensions`** antes de postar pra entender o tom
- [ ] **não** mencionar concorrentes por nome (deixa orgânico)
- [ ] **responder** perguntas em 24h
- [ ] se moderadores pedirem pra mover pra outro canal, mover
- [ ] **não** fazer DM spam
- [ ] **não** postar links Gumroad diretamente no canal (vai pra
      thread ou reply)

## quando postar

- terça/quarta/quinta 14-18h CET (Berlin time, onde Ableton fica)
- evitar segunda (devs atolados em planning) e sexta (TGIF)

## acompanhamento

depois de postar, ficar de olho por 48h em:

- perguntas técnicas sobre Extensions SDK
- pedidos de feature
- reports de bug
- pedidos de "como faço X"

cada reply é uma chance de:

1. mostrar competência técnica
2. ganhar confiança da comunidade
3. identificar features pedidas (input pro roadmap)
4. recrutar contributors

## follow-up depois de 7 dias

se a mensagem teve tração boa (>5 reactions, >3 thread replies),
postar update:

```
Quick 1-week update on RC Bridge:
- 100+ downloads
- 5 GitHub issues filed (3 fixed)
- 1 contributor PR merged
- New: [feature X from feedback]

Still looking for feedback on [Y].

Next milestone: v0.5 with WebRTC multi-phone.
```

## contatos úteis no Discord

procurar这些人 (se existirem):

- time Extensions SDK da Ableton (pessoas com o badge Extensions)
- mods do `#extensions`
- contributors ativos

**não** mencionar que é a primeira extension controller (se alguém
já postou algo parecido, dar crédito). foco é compartilhar, não
competir.