# Plano de Publicação — Ableton RC Surface v0.5.7

**data:** 2026-07-06
**projeto:** `ableton-rc-surface` v0.5.7 (`a4709f6`)
**artefatos prontos:** `Ableton-RC-Surface-0.5.7.ablx` (307 KB), `release-kits/Ableton-RC-Surface-0.5.7-test.zip` (417 KB, com `RC-Midi-Receiver.amxd`)
**autor:** worm (operador) + Antigravity (IDE Agent) + Argos (final repository agent)

---

## TL;DR

Publicação em **3 frentes paralelas** por ordem de prioridade. Cada frente é independente — pode rodar simultaneamente. **Nenhuma frente dispensa aprovação explícita do operador antes de ação irreversível.**

| # | frente | prioridade | status | quem executa |
|---|---|---|---|---|
| 1 | **GitHub Releases** | P0 — sério | pendente | operador + Argos (com aprovação) |
| 2 | **Discord `#🧩｜extensions`** | P1 — comunidade | pendente | **só operador posta** (Argos é read-only no Discord) |
| 3 | **Gumroad (pay-what-you-want)** | P2 — distribuição | pendente | **só operador** (credenciais/account dele) |

**backup canônico em paralelo:** copiar `.ablx` pra `ableton-extensions/releases/` (hub local). Pode ser feito por Argos com aprovação.

---

## Frente 1 — GitHub Releases (P0)

### por quê primeiro

- é o **link permanente e versionado** que vai ser referenciado em todos os outros lugares (Discord, Gumroad, blog)
- é a fonte de verdade pra issue tracking
- é o único canal de distribuição **verificável** (SHA-256, tag, changelog)
- se tu publicar Discord ou Gumroad **sem** o GitHub Release antes, o post aponta pra "em breve" e tu perde credibilidade

### estado atual

- repo local: `/mnt/c/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-surface/` (Windows: `C:\Users\Usuario\repos\ableton-extensions\source-repos\ableton-rc-surface`)
- branch: `main`
- HEAD: `a4709f6 fix(pages): link download button to GitHub Releases; docs: add landing page link to README`
- tag: `v0.5.7` existe ✓
- **remote: vazio** — `git remote -v` retorna nada
- working tree: clean

### passos (exatos, com comandos)

1. **operador cria o repo na conta dele** (GitHub web UI)
   - nome sugerido: `ableton-rc-surface`
   - visibilidade: **público**
   - **NÃO** marcar "Initialize with README" (a gente já tem)

2. **operador passa o token / credencial pro Argos**
   - opção A: PAT (personal access token) com scope `repo` — colar em chat pra eu usar no `git remote add` + push (token descartável, recomendado)
   - opção B: operador roda `git push` manualmente depois que eu preparo tudo
   - **Argos não guarda token em memory**. depois de usar, descarta.

3. **Argos prepara o push (read-only na fonte, só adiciona remote)**
   **Windows (PowerShell):**
   ```powershell
   cd C:\Users\Usuario\repos\ableton-extensions\source-repos\ableton-rc-surface
   git remote add origin <url-do-repo>
   git remote -v   # confirma
   ```
   **WSL (Bash):**
   ```bash
   cd /mnt/c/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-surface
   git remote add origin <url-do-repo>
   git remote -v
   ```

4. **Argos faz push do branch + tags**
   **Windows (PowerShell):**
   ```powershell
   git push -u origin main
   git push origin v0.5.7
   ```
   **WSL (Bash):**
   ```bash
   git push -u origin main
   git push origin v0.5.7
   ```

5. **operador cria a Release** (Argos pode preparar o draft via `gh release create --draft`, mas **criar + publicar exige aprovação**)
   ```bash
   gh release create v0.5.7 \
     --title "v0.5.7 — Mobile MAP mode + MIDI trigger notes + XY axis mapping" \
     --notes-file docs/release-notes-v0.5.7.md \
     Ableton-RC-Surface-0.5.7.ablx \
     release-kits/Ableton-RC-Surface-0.5.7-test.zip
   ```
   - **decisão**: Argos cria como `--draft`, operador revisa + publica com `gh release edit v0.5.7 --draft=false`

### o que Argos precisa do operador

- URL do repo criado (ex.: `https://github.com/worm-arg/ableton-rc-surface.git`)
- PAT com scope `repo` (se Argos for fazer o push)
- aprovação explícita antes de cada `git push` ou `gh release create`

### o que Argos faz sozinho

- adicionar remote
- push do main + tag
- preparar draft do release notes (puxar do `CHANGELOG.md` + `docs/release-notes-v0.5.7.md` se existir)
- criar release como draft

### o que Argos **NÃO** faz sem autorização explícita

- `git push` (regra SOUL.md: zero push sem aprovação)
- `gh repo create`
- `gh release create` em modo publicado (só draft)
- qualquer coisa que exponha o repo publicamente

### arquivos a anexar na Release

- `Ableton-RC-Surface-0.5.7.ablx` (307 KB) — instalador único
- `release-kits/Ableton-RC-Surface-0.5.7-test.zip` (417 KB) — tester kit com `RC-Midi-Receiver.amxd`
- `docs/release-notes-v0.5.7.md` (a criar, puxar do CHANGELOG)

---

## Frente 2 — Discord `#🧩｜extensions` (P1)

### por quê segundo

- é o canal de showcase oficial da comunidade Ableton
- devs postam lá (ex.: `fishfvch` postou extension de MIDI theory em 3/jul)
- gera feedback real, testers, e bug reports via Centercode
- depende do link do GitHub Release estar público (por isso vem depois)

### estado atual

- canal: `#🧩｜extensions` (id `1510930577266835456`), categoria MAX FOR LIVE
- canal errado pra postar: `#🥽｜extensions-sdk` (id `1510930813515206716`) — só questões técnicas/SDK
- canal certo pra showcase alternativo: `#🖼️｜extensions-community-gallery` (forum, id `1510931011217915954`) — opção B se operator preferir forum ao chat
- mod ativo: `fedpep` (Ableton staff, responde rápido, modera)
- regra da comunidade: post single-message, sem split, sem edits depois de publicar

### draft pronto (de `docs/marketing/discord-post-2026-07-03.md`)

já existe **3 variantes** (A completa, B curta, C foco em sensor). Tudo escrito em inglês (regra da galeria).

**escolha recomendada**: **Variante A** (a mais completa) — funciona como apresentação canônica.

**atualizações pendentes** (Argos pode aplicar agora, read-only no arquivo):
- trocar `0.5.6` → `0.5.7` em todas as variantes
- trocar "pre-alpha" → "v0.5.7 stable" (ou manter pre-alpha se for mais honesto — decisão do operador)
- trocar `[gumroad link]` e `[github link]` placeholders pelos URLs reais depois que as outras 2 frentes tiverem link público

### regras rígidas (do draft existente)

- **postar em `#🧩｜extensions`**, não em extensions-sdk
- terça ou quarta, 14:00–16:00 BRT (pico de atividade)
- esperar 48h após fedpep reagir a outro post recente do canal (mitiga risco de modération mood)
- **post single message** — não split em várias
- **NÃO** citar concorrentes (TouchOSC, Lemur, Liine, OSC Bridge)
- **NÃO** prometer features fora da SDK (no automation curves, MPE, modulation matrix, host audio I/O)
- declarar human-authored uma vez, no body
- depois de postar: **zero edits**. correção = mensagem de follow-up separada.

### o que Argos faz

- atualiza o draft em `docs/marketing/discord-post-2026-5.7.md` (criar novo arquivo, não sobrescrever o de 03/jul)
- calcula SHA-256 do `.ablx` pra cross-check com Gumroad
- prepara os placeholders finais depois que GitHub/Gumroad saírem
- **NÃO posta** — read-only no Discord (regra SOUL.md)

### o que o operador faz

- escolhe variante (A/B/C) ou escreve a própria
- cola o texto no Discord
- responde thread se tiver perguntas

### arquivos a criar/atualizar

- **criado** `docs/marketing/discord-post-2026-07-06.md` ✓ (variante final aprovada, com versão correta)
- **criado** `docs/release-notes-v0.5.7.md` ✓ (release notes completos)

---

## Frente 3 — Gumroad (P2)

### por quê terceiro

- é canal de **distribuição alternativa** (download direto, sem GitHub account)
- pay-what-you-want ($0 min) — alinhado com "Forever free" do README
- gera page customizada (não só um link de arquivo)
- precisa credencial do operador, Argos **não pode fazer sozinho**

### estado atual

- draft completo em `docs/marketing/gumroad-page-draft.md` (79 linhas)
- **SHA-256 Calculados para v0.5.7**:
  - `Ableton-RC-Surface-0.5.7.ablx`: `728B264DB95874D568BB59582B2EC922194892B717C7EAF6DA28BFAF4BAB9604`
  - `Ableton-RC-Surface-0.5.7-test.zip`: `14A8C24DC3561C685E794B273BC8B49A67AC5A9B9A54A0482C132F5EB2370F5D`
- **placeholder GitHub link**: `https://github.com/ableton-extensions/ableton-rc-surface` (ou conta pessoal `https://github.com/worm-arg/ableton-rc-surface.git`)
- preço: pay-what-you-want (minimum $0) ✓
- categoria: Software / Audio & MIDI tools

### passos

1. **operador cria a conta/produto no Gumroad** (web UI)
   - **Argos não tem acesso** a credenciais Gumroad
2. **operador atualiza o draft** com:
   - versão `0.5.7` (substituir todos os `0.5.6`)
   - SHA-256 novo do `.ablx` v0.5.7
   - link real do GitHub Release (da Frente 1)
   - link real do release notes (`docs/release-notes-v0.5.7.md`)
   - screenshots/GIF do V1 (instalação) — vídeo final marcado em `docs/VIDEOS.md`
3. **operador faz upload** do `Ableton-RC-Surface-0.5.7.ablx`
4. **operador publica** a página

### o que Argos faz

- Calcula e valida SHA-256 do `.ablx` e `.zip` novos (já calculados e salvos no draft).
- **criado** `docs/marketing/gumroad-page-2026-07-06.md` ✓ (contendo versão 0.5.7 e checksums reais).

### o que Argos **NÃO faz**

- criar/logar em conta Gumroad
- upload do `.ablx` pra Gumroad
- publicar a página

---

## Bônus — Backup canônico local (F0, paralelo)

### o que é

copiar o `.ablx` v0.5.7 pra `ableton-extensions/releases/` (hub pai). backup histórico, não é publicação externa.

### estado atual

- `ableton-extensions/releases/` já tem 47 `.ablx` (todos `Ableton-RC-Bridge-*` antigos)
- nenhum `Ableton-RC-Surface-*` foi pra lá ainda

### passos (Argos pode fazer com aprovação)

**Windows (PowerShell):**
```powershell
Copy-Item -Path .\Ableton-RC-Surface-0.5.7.ablx -Destination ..\..\releases\
Copy-Item -Path .\release-kits\Ableton-RC-Surface-0.5.7-test.zip -Destination ..\..\releases\
```

**WSL (Bash):**
```bash
cp /mnt/c/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-surface/Ableton-RC-Surface-0.5.7.ablx /mnt/c/Users/Usuario/repos/ableton-extensions/releases/
cp /mnt/c/Users/Usuario/repos/ableton-extensions/source-repos/ableton-rc-surface/release-kits/Ableton-RC-Surface-0.5.7-test.zip /mnt/c/Users/Usuario/repos/ableton-extensions/releases/
```

---

## Sequência recomendada (1 dia)

```
[t+0h]  Argos calcula SHA-256 do v0.5.7.ablx
        Argos atualiza drafts locais (Discord + Gumroad) com 0.5.7 + SHA novo
        Argos cria release notes em docs/release-notes-v0.5.7.md
[t+0h]  operador cria repo no GitHub (10 min)
[t+1h]  Argos adiciona remote + push main + tag v0.5.7 (com aprovação)
        operador valida no GitHub
[t+1h]  Argos cria release como DRAFT (gh release create --draft)
        operador revisa + publica
[t+2h]  operador atualiza Gumroad page com SHA + link GitHub + vídeo V1
        operador publica Gumroad
[t+3h]  backup local: Argos copia .ablx pro hub (com aprovação)
[t+4h]  operador cola Discord post (variante A ou B)
        espera reação fedpep em 24-48h, responde thread
[t+24h] Argos monitora feedback Discord (read-only) e reporta pra operador
```

**paralelos possíveis** (se Argos e operador trocarem info rápido):
- backup local pode rodar a qualquer momento
- Gumroad e Discord podem ser preparados enquanto GitHub Release tá em draft

---

## Riscos e decisões pendentes

### operador precisa decidir

1. **nome do repo GitHub** — `ableton-rc-surface` (sugestão) ou outro?
2. **owner** — conta pessoal ou criar org `ableton-extensions`?
3. **visibilidade** — público (provavelmente) ou private?
4. **Discord variant** — A (completa), B (curta), C (sensor focus)?
5. **Discord timing** — respeitar 48h após fedpep reagir a BRNK (02/jul) → pode postar 04/jul+. Hoje é 06/jul, janela aberta.
6. **Gumroad preço real** — manter pay-what-you-want $0 min?
7. **SHA-256 fixo vs auto-gerado** — Argos calcula e trava no draft?

### riscos técnicos

- **Windows ↔ WSL sync** (gotcha memória): `sync; sleep 2; cp` em qualquer escrita WSL→Windows
- **Ableton staff reaction** (`fedpep`): pode aprovar ou pedir ajuste. preparar 1 follow-up pronto caso ele peça mudanças.
- **GitHub Rate limit**: irrelevante pra 1 push inicial.

### o que Argos **NÃO vai fazer** mesmo com aprovação

- `git push --force` em qualquer branch
- delete do repo
- mudar visibilidade depois de público
- postar no Discord com a conta do worm
- logar em Gumroad / Discord / GitHub com credenciais do worm

---

## Aprovações necessárias (resumo)

| ação | aprovação |
|---|---|
| adicionar remote | implícita se operador passou URL |
| `git push` | **explícita por push** |
| `gh release create --draft` | implícita se operador pediu release |
| `gh release edit --draft=false` (publicar) | **explícita** |
| postar no Discord | **só operador** (Argos é read-only) |
| login/upload Gumroad | **só operador** |
| copiar `.ablx` pra hub local | **explícita** |

---

## Status dos arquivos criados/modificados

- `docs/release-notes-v0.5.7.md` (criado e revisado) ✓
- `docs/marketing/discord-post-2026-07-06.md` (criado com placeholders estruturados) ✓
- `docs/marketing/gumroad-page-2026-07-06.md` (criado com os hashes SHA-256 e versão 0.5.7) ✓
- `ableton-extensions/releases/Ableton-RC-Surface-0.5.7.ablx` (cópia local pendente de aprovação)
- `ableton-extensions/releases/Ableton-RC-Surface-0.5.7-test.zip` (cópia local pendente de aprovação)