# Frequently Asked Questions

> Respostas às perguntas mais comuns sobre **Ableton RC Bridge**.
> Última atualização: junho de 2026.

## Índice

- [Compatibilidade](#compatibilidade)
- [Instalação e primeiro uso](#instalação-e-primeiro-uso)
- [Recursos e funcionalidades](#recursos-e-funcionalidades)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Comunidade e contribuição](#comunidade-e-contribuição)

---

## Compatibilidade

### Funciona no Live 11?

Não. Precisa do Live 12.4.5+ Suite porque usa o novo Extensions SDK que saiu nessa versão. Pra Live 11 tem outras ferramentas com OSC bridge.

### Funciona com FL Studio / Logic / Bitwig / Reaper?

Não, só Ableton Live 12.4.5+ Suite. Outras DAWs precisariam de um host diferente — não é o que essa extensão faz. O celular em si poderia ser reaproveitado por alguém que escrevesse um host pra outra DAW, mas o código da extensão é Live-específico.

### Funciona em Windows e Mac?

Sim, nos dois. Windows 10/11 e macOS (Intel e Apple Silicon). Linux não — Ableton não roda Linux. Cada SO tem instruções específicas de instalação em `docs/INSTALL.md`.

### Funciona no iPhone?

Sim, iOS 15.4+ no Safari. Touch, sensores (giroscópio, acelerômetro, luz, microfone, câmera) funcionam igual ao Android. **Limitação:** iOS Safari não implementa `navigator.vibrate` (haptics), então resposta tátil só funciona no Android. iOS 14.5 ou abaixo não aceita cert self-signed — não conecta. Wake Lock em background também só Android.

### Qual a latência? Dá pra tocar ao vivo com isso?

30 Hz de atualização bidirecional, latência end-to-end abaixo de 50 ms em Wi-Fi 5 GHz. Dá pra usar ao vivo — bem abaixo do limiar de percepção pra controles contínuos (CC, knobs, faders, XY). Pra timing apertado tipo bater em pad, fica entre 50–80 ms em 2.4 GHz congestionado, ainda ok pra performance casual. **Recomenda-se 5 GHz pra resultado consistente.**

### Tem suporte a qual versão do Ableton Live?

Live 12 BETA (Suite). Especificamente 12.4.5+ porque usa o Extensions SDK novo que saiu nessa versão. Editions mais antigas do Live (Intro, Standard) não têm Extensions SDK.

### Funciona em projetores externos / em show ao vivo?

Não foi feito pra projetar em tela externa. A interface é otimizada pro celular/iPad/tablet mesmo — a ideia é o celular virar o controlador, seja pra mix ou performance. Se quiser projetar a tela do Live em show, faz normalmente do jeito tradicional.

---

## Instalação e primeiro uso

### Como começo? Passo a passo rápido.

1. Instala o Ableton Live 12.4.5+ Suite Beta mais recente
2. Baixa a extensão `Ableton-RC-Bridge-x.y.z.ablx` da página de Releases no GitHub
3. Duplo-clique no `.ablx` → Live oferece instalar → clica Install
4. No Live, clica direito em qualquer track → Extensions → Ableton RC Bridge → Show panel
5. Escaneia o QR code com o celular → toca

### Preciso de internet?

Não. Funciona offline, na sua rede local. Celular e computador onde o Live roda precisam estar no **mesmo Wi-Fi**. Sem internet, sem cloud, sem dados saindo da sua rede.

### Preciso saber programar pra usar?

Não. Instala a extensão, escaneia o QR, toca. Programação só é necessária se você quiser customizar o visual do celular ou contribuir com código.

### Meu antivírus tá reclamando do `.ablx`, é malware?

Não. Pode acontecer porque a extensão usa WebSocket, HTTPS e certificado local. Esses elementos podem parecer suspeito pro antivírus, mas é só como ela funciona — gera um cert HTTPS único por install pra permitir câmera/microfone no browser. Tudo roda offline, na sua rede local. O código é 100% open-source (MIT), qualquer pessoa pode revisar.

---

## Recursos e funcionalidades

### Os pads/knobs funcionam com qualquer dispositivo MIDI no Live, ou só com coisas específicas?

Todo parâmetro disponível no Live é mapeável. Instrumentos, devices custom (Max for Live inclusive), efeitos de áudio, mixer, automação, tudo. Você clica no parâmetro no Live, mapeia pro knob/pad/fader do celular, e ele passa a controlar.

### Quantos celulares podem conectar ao mesmo tempo?

Até 4 celulares simultâneos, todos com sensores ligados. Cada um pode ser um cliente independente (performance, admin, mix).

### Tem haptics (vibração) no celular quando aperto um pad?

Tem, primeira implementação já funciona. É feature experimental ainda — funciona mas pretendo melhorar nas próximas versões. Lembrando: haptics só no Android (iOS Safari não suporta `navigator.vibrate`).

### Posso customizar o visual do controlador no celular?

Sim. O código do celular tá no repo (open-source, MIT). Se você entende de código (HTML/JS/CSS), pode editar a interface como quiser, adicionar novos controles, novos parâmetros, novos mapeamentos. O pacote inclui instruções de como customizar.

### Tem como salvar e compartilhar mapeamentos?

Salvar e carregar localmente, sim — primeira versão já tem. Exportar e compartilhar com outras pessoas ainda não — vai vir nas próximas versões.

### Como eu atualizo pra uma versão nova?

Novas versões saem no repo oficial do GitHub (Releases). Baixa o novo `.ablx`, duplo-clique, Live substitui a versão antiga. Conforme bugs forem reportados e features novas forem pedidas (e eu tiver tempo), vou lançando versões novas. Outros usuários também podem fazer forks com suas próprias versões.

### Se eu já uso outra ferramenta, faz sentido migrar?

Pode ser uma alternativa. O objetivo do projeto era criar algo que não precisasse pagar, que tivesse as funcionalidades e fosse compatível com qualquer celular. Se você já tá feliz com a outra, sem necessidade de trocar — pode usar em paralelo inclusive. Se quiser experimentar, é open-source e gratuito.

---

## Privacidade e segurança

### Os dados ficam na nuvem? Alguém consegue ver o que eu faço?

Não. Nada vai pra nuvem. Não tem servidor remoto, não tem telemetria, não tem analytics, não tem nada rodando em segundo plano coletando dados. Tudo roda local, no seu computador e na sua rede. O código é open-source (MIT), qualquer pessoa pode auditar pra confirmar.

### Tem política de privacidade? Onde fica esse documento?

Sim, tá em `docs/PRIVACY.md` no GitHub. Resumo: zero coleta, zero telemetria, tudo roda local, MIT. Câmera e microfone são opt-in e processados no próprio browser.

### Tem algum risco de segurança em deixar isso rodando?

Não. Roda 100% local, só abre porta na sua rede Wi-Fi pra dispositivos que você conectou. Sem internet, sem cloud, sem servidor externo. O cert HTTPS é auto-assinado e único por install. Modelo de ameaça documentado em `docs/SECURITY.md` — uso doméstico/studio, não exposto pra internet.

### Tem que pagar? Tem versão Pro?

Gratuito, sem pagar, open source. MIT. Sem versão Pro, sem feature bloqueada, sem nada. Se quiser ajudar pode doar qualquer valor pelo Gumroad, mas nunca obrigatório.

---

## Comunidade e contribuição

### Tem um Discord ou comunidade própria pra trocar ideia?

Não tem comunidade própria ainda. Usa o Discord oficial do Ableton, canal `#extensions`. Lá é onde o time da Ableton e quem tá construindo extensions se reúne.

### Como faço pra contribuir? Posso mandar código?

Pelo GitHub. Faz um fork, cria um branch com sua mudança, abre um Pull Request contra o repo principal. Ou só abre uma Issue com bug report / feature request. Tudo passa pela página do projeto no GitHub.

---

## Ver também

- [`INSTALL.md`](./INSTALL.md) — guia de instalação detalhado
- [`PRIVACY.md`](./PRIVACY.md) — política de privacidade completa
- [`SECURITY.md`](./SECURITY.md) — modelo de ameaça e design de segurança
- [README](../../README.md) — overview do projeto