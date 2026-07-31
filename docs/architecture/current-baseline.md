# Current Architecture Baseline — RC Surface

**Data / Horário**: 2026-07-29T18:05:00-03:00
**Repositório**: `ableton-rc-surface`
**Repositório canônico**: `C:\Users\Usuario\repos\ableton-extensions\source-repos\ableton-rc-surface`

---

## 1. Ambiente e Ferramentas

| Ferramenta / Runtime | Versão |
|---|---|
| **Node.js** | `v24.13.1` |
| **npm** | `11.8.0` |
| **Python** | `3.10.11` |

---

## 2. Estado de Controle de Versão

- **SHA Base**: `c76743b6a21344a7e680855c6b9d4b479560d1d8` (`c76743b`)
- **Branch de integração (histórico)**: `architecture-upgrade/rc-surface`
- **Repositório canônico**: `C:\Users\Usuario\repos\ableton-extensions\source-repos\ableton-rc-surface`
- **Nota Informativa — Estado do Checkout Original**:
  - Checkout limpo (sem modificações locais pendentes).

---

## 3. Scripts de Teste, Build e Artefatos Esperados

- **Script de Teste Static Baseline**: `npm run test:static`
- **Script de Teste Completo**: `npm test` (`npm run test:static && npm run test:src`)
- **Script de Build**: `npm run build` (`tsc --noEmit && tsx build.ts`)
- **Script de Build Prod**: `npm run build:prod`
- **Artefatos Esperados**:
  - `dist/extension.js`
  - `dist/static/`
  - Artefato de empacotamento `.ablx`: `Ableton-RC-Surface-0.5.8.4.ablx`

---

## 4. Resumo da Execução da Suíte Baseline

- **Suíte Executada**: `npm run test:static`
- **Total de Testes**: 248
- **Passando**: 248
- **Falhando**: 0
- **Tempo de Execução**: 713ms
- **Status**: OK (PASSING)
- **Observação**: `test:src` requer contexto de runtime com `tsx` vinculado em node_modules.
