# Stress Test Bug Findings — v0.5.8 release

Diagnostic session: 2026-07-07. Tooling: `ableton-debugger-mcp` v0.1.3 + new `scripts/stress/fake-phone-headless.mjs` + `admin-observer.mjs` + `fake-phone-multi.mjs` + `launch-clients.sh`.

Targets:
- RC Surface v0.5.7/v0.5.8 branch `v0.5.8-bugfixes` running at `wss://192.168.100.2:59065/ws` (HTTP 59064)
- Live with track `RC_TEST_DUMMY` (midi)
- ableton-debugger-mcp v0.1.3 on `127.0.0.1:9888` (TCP)

---

## BUG #1 — `global is not defined` in `/ws` transport_state

**Severity:** HIGH → **FIXED in `0c52293`**

**Root cause confirmed:** esbuild's CJS bundling wraps osc-min in a `__commonJS()` adapter that, at module-scope eval time, runs
```js
typeof globalThis === "object" ? globalThis : typeof global === "object" ? global : ...
```
Ableton Live's extension host is strict ESM with no `global` binding — so the second `typeof global` raises `ReferenceError`. The error propagates as `state.error = "global is not defined"` in the `/ws` hello payload.

**Fix:**
- `build.ts` → `external: ["osc-min"]` on `esbuild.build()`
- `src/live/osc-transport.ts` → uses `import * as osc from 'osc-min'`
- Bundle now ships `require("osc-min")`, resolved at runtime by the host's loader.

**Verification pending:** user must reload the .ablx in Live and confirm `transport_state.error` becomes `null` in the hello handshake.

**Likely impact on LFOs/Stutters desync:**
- LFOs/Stutters are server-side (`src/live/mappings.ts:tickHostModulators` runs at `HOST_MODULATOR_INTERVAL_MS = 20ms = 50Hz`)
- They were already receiving modulator updates, but the broken transport_state may have caused connected==false → caller chose non-sync clockSource → potential drift in sync-mode modulators

---

## BUG #2 — test #35 stale (release-cleanup expected docs/landing/index.html) → **FIXED**

path moved in commit `0ebd31b docs(pages): move landing to docs/index.html` but the test never updated. Patched.

---

## BUG #3 — server `modulator` handler doesn't update lastData → **FIXED**

`src/server/ws.ts:319` now sets `info.lastData = parsed` before returning false. Admin observers will see `lastData.kind === "modulator"` consistently during LFO/Stutter drives instead of being latched to the first resume envelope.

---

## Finding #4 — LFOs/Stutters run server-side at 50Hz → **DOCUMENTED**

`HOST_MODULATOR_INTERVAL_MS = 20` in `src/live/mappings.ts:234`.
- 1 LFO @ 8Hz × sine → admin broadcast ~24Hz (natural rate change-driven)
- 4 LFOs + 4 stutters = 8 modulators → admin broadcast scaled sub-linearly to ~187Hz
- burst test of 8 concurrent fake clients was blocked by `closeDuplicateIpClients` (intentional behavior)

---

## Finding #6 — `closeDuplicateIpClients` (intentional) → **DOCUMENTED**

`src/server/ws.ts:135-149` kills any non-admin client whose IP matches a fresh WebSocket. Real-world: prevents one cell phone losing network from leaving a phantom session. Stress-test implication: cannot test with multiple fake clients from the same source IP without disabling this.

---

## Diagnostic infrastructure added (branch `v0.5.8-bugfixes`)

| file | purpose |
|---|---|
| `scripts/stress/fake-phone-headless.mjs` | pure-WS fake phone client (1 modulator at a time) |
| `scripts/stress/fake-phone-multi.mjs` | multi-modulator from one client (sweep N) |
| `scripts/stress/admin-observer.mjs` | `/admin/ws` listener; reveals broadcast rate |
| `scripts/stress/launch-clients.sh` | helper: spawn N parallel fakes |
| `scripts/stress/BUGFINDINGS.md` | this document |

## Stress-test baselines

| run | modulators | admin rate | notes |
|---|---|---|---|
| 1 lfo @ 0.5Hz | 1 | ~24Hz | healthy |
| 1 lfo @ 16Hz | 1 | ~24Hz | burst didn't drop |
| 4 lfo + 4 stutter | 8 | ~187Hz | server cope |
| 8 parallel fakes (launch-clients) | — | — | blocked by `closeDuplicateIpClients` |

## Test gates passed

- `npm run build:prod` → clean
- `npm run package` → builds `Ableton-RC-Surface-0.5.8.ablx` (304KB)
- `npm test` → **215/215** (was 177/178)

## Releases

- `Ableton-RC-Surface-0.5.8.ablx` at project root + `/mnt/c/Users/Usuario/repos/ableton-extensions/releases/`
- git tag `v0.5.8` → commit `e5584fd`

## Open follow-ups for next iteration

1. **Validate bug #1 fix in Live**: reload .ablx, curl `/ws`, expect `transport_state.error: null`
2. **stress test with mapping**: needs Playwright + browser UI to map `toggle-1` → `RC_TEST_DUMMY` volume, then run drift probe on parameter value history
3. **burst test bypass**: either set HTTP `X-Forwarded-For` per fake, or add env flag to disable `closeDuplicateIpClients` for stress runs


---

## Finding #7 — server picks random port (`startServer` uses `listen(0)`)

**Captured**: 2026-07-07 from `fake-phone-headless.mjs` log: server bound to `58672`, not the historically planned `59064/59065`.

**Root cause**: `src/server/state.ts:142`: `srv.listen(0, "0.0.0.0", ...)` — `0` requests an OS-assigned ephemeral port.

**Impact**:
- QR in panel always points at a "mystery port" — not memorable for the user.
- Conflicts with other Ableton extensions that bind random ports aren't deterministic.
- Docs, blog posts, video tutorials all say `59064/59065` — they no longer work.

**Fix**: env var `RC_SURFACE_PORT`. If set, bind to that. If unset, keep `0` random. Document in `README.md`.

## Finding #8 — `transport_state` broadcasts at ~50Hz even with 0 active modulators

**Captured**: 2026-07-07, admin observer saw `transport_state` at ~50Hz for 14+ seconds with no LFO/stutter active.

**Root cause**: `HOST_MODULATOR_INTERVAL_MS = 20ms` (50Hz tick) drives the broadcast loop, but the broadcaster doesn't filter "no change → no send".

**Impact**: dormant phone still receives 50 useless JSON objects/sec, draining battery + WiFi bandwidth.

**Fix**: skip broadcast if state didn't materially change since last send (delta check on `state` field).

## Follow-up add for v0.5.8.1

- bug #7 fix
- bug #8 fix
- clean stale `.ablx` from root (`0.5.7`, `0.5.9` abandoned)
- move valid `.ablx` to `releases/` (currently empty)
- tag `v0.5.8.1`

---

## Finding #8 — REVISITED, NOT A BUG, false alarm

I initially measured ~50Hz of `transport_state` from admin observer log, but
re-checking with admin-observer-only (no fake-phone): server emits transport
only when state changes. The transport broadcast already has a 100ms throttle
(THROTTLE_MS = 100, `src/server/ws.ts:486`). What I was reading was actually
`client_update` for an existing client whose `lastData.kind` was empty (waiting
on modulators) — admin sent 21 in 6s = 3.5Hz, not 28Hz.

Caveat: when a `client_update` payload still includes the full `history` blob
(it carries `c.history` across the wire), idle admin panels receive ~3.5Hz
JSON packets containing every series. For phones that's fine, but the admin
web UI is a fresh client receiving a heavy payload continuously. Lower-priority
optimisation: skip `client_update` when neither `lastData` nor `history` changed
since last push (delta-only). NOT a release blocker — defer to v0.5.9+.


---

## Finding #8 — REVISITED, NOT A BUG, false alarm

I initially measured ~50Hz of transport_state from admin observer log, but
re-checking with admin-observer-only (no fake-phone): server emits transport
only when state changes. Throttle already exists (THROTTLE_MS = 100,
src/server/ws.ts:486). What I was reading was client_update (3.5Hz, not 28Hz).

Lower-priority follow-up: skip client_update when neither lastData nor history
changed since last push (delta-only). Not a release blocker.

---

## Finding #9 — `RC-Midi-Receiver.amxd` patcher fiação incompleta (status byte perdida)

**Captured**: 2026-07-07, user-reported via voice: quando configura nota custom (ex. "C8") no `RC-Midi-Receiver.amxd`, o trigger MIDI sempre dispara **as mesmas duas notas default** (60=C3 e 12=C0), nunca a nota que ele setou.

**Diagnóstico** (without Max CLI access):
- `static/RC-Midi-Receiver.amxd` é JSON Max patcher com 5 boxes:
  - `obj-1`: `udpreceive 9000 @outputformat rawbytes`
  - `obj-2`: `unpack 0 0 0` → 3 outlets (status, note, velocity)
  - `obj-3`: `pack 0 0` (recebe note+velocity)
  - `obj-4`: `midiformat` (numinlets=7, recebe só o pack → "note+vel" via inlet 0,1)
  - `obj-5`: `midiout`
- **Status byte (unpack outlet 0) está conectado APENAS ao botão ACTIVITY (obj-9)**, nunca chega no midiformat.
- Sem o status byte, `midiformat` usa defaults internos: status `0x90` (note-on ch1) MAS a nota a ser tocada é determinada pelo inlet 0, que recebe... vamos ver:

Fluxo atual:
1. unpack outlet 0 (status=0x90) → botão ACTIVITY (consumido/ignorado)
2. unpack outlet 1 (note) → pack 0 0 inlet 0
3. unpack outlet 2 (vel) → pack 0 0 inlet 1
4. pack output → midiformat inlet 0 (vai como byte1 da MIDI message)
5. midiformat: inlet 0=byte1=NOTE, inlet 1=byte2=VELOCITY, status byte fica o LAST SEEN (`0x90` último valor)

Wait, refazendo: midiformat recebe **inlet 0 = nota (vinda do pack)**, **inlet 1 = velocity (vinda do pack — ou é velocity?)**. Sem inlet 2 status, ele usa default. Provavelmente: nota É a entrada do `pack → midiformat inlet 0` (interpretado como byte1=note). E velocity seria inlet 1. **Status default** — talvez o último recebido, talvez outro.

Ah, **outra interpretação**: como pack só tem 2 valores (note, vel) e midiformat tem 7 inlets, midiformat pode estar usando o pack como 2 primeiros bytes, gerando uma **Note-On MIDI 0x90 default + valor nota=vem da pack inlet 0**.

OK, sem Max não dá pra reproduzir. **`bug fix requer Max patcher access`**.

**Fix (a fazer pelo usuário, EU não tenho Max CLI)**:

1. Abrir `RC-Midi-Receiver.amxd` no Max 9.1
2. Selecionar `obj-2 (unpack 0 0 0)` outlet 0 (a do status)
3. Arrastar patchline para `obj-4 (midiformat)` inlet **mais à esquerda** (inlet 0 = status)
4. Verificar inlet 1 = nota, inlet 2 = velocity (reordenar se preciso)
5. Salvar (Ctrl+S / Cmd+S)
6. Substituir `static/RC-Midi-Receiver.amxd` no projeto
7. Rebuild + repackage

**Workaround temporário (lado host)**:
- O host já envia `[status, note, velocity]` correto via UDP. Em vez de mexer no `.amxd`, posso **reformatar o protocol** pra enviar pack pronto, mas isso quebra compat com `.amxd` atual.

**Recomendação**: pedir pro user abrir o patcher no Max + screenshot pra eu descrever passo-a-passo.


---

## Finding #9 — fix path + step-by-step for user

### Visual confirmation
User-provided screenshot of the open `.amxd` patcher confirms:
- `udpreceive 9000 @outputformat rawbytes` → `unpack 0 0 0`
- `unpack` outlet 0 (status) → ACTIVITY button (consumido/ignorado, ok)
- `unpack` outlet 1 (note) → `pack 0 0` inlet 0
- `unpack` outlet 2 (vel) → `pack 0 0` inlet 1
- `pack 0 0` output → `midiformat` inlet 0 (SOMENTE este fio)
- `midiformat` só tem **1 inlet conectado** (inlet 0)
- `midiformat` → `midiout`

### Root cause
`pack 0 0` outputs **dois valores** (note e velocity) em **dois ticks**, mas só um fio cabe saindo dele na fiação atual. Como só inlet 0 do `midiformat` está conectado, midiformat recebe **só o note number**, ignorando a velocity (default 64).

Resultado: disparando qualquer controle, midiformat toca a nota **do último note-on recebido** com velocity default 64, channel 0, status 0x90 (defaults internos). Como user vê "sempre as mesmas duas notas", provavelmente está observando **notas residuais** — o velocity default 64 permite note-on sem note-off limpar direito (note hanging), e o próximo note-on substitui o anterior.

### Fix (5 clicks no Max)

1. Abrir `RC-Midi-Receiver.amxd` no Max 9.1
2. Localizar `pack 0 0` (logo abaixo de `unpack 0 0 0`)
3. Click+drag do outlet da **direita** do `pack 0 0` (= velocity, segundo output)
4. Soltar em cima do **`midiformat` inlet 1** (segundo inlet da esquerda pra direita)
5. Salvar (Cmd+S ou Ctrl+S) e substituir o arquivo em `static/RC-Midi-Receiver.amxd`

Depois do fix:
- inlet 0 (pitch) ← pack outlet 0 (note number)
- inlet 1 (velocity) ← pack outlet 1 (velocity)
- inlets 2-6 ficam com defaults (canal 0, status 0x90 note-on)

Reempacotar:
```
cd source-repos/ableton-rc-surface
npm run build:prod && npm run package
```

### Alternative: skip Max altogether

If the user can't / won't open Max, the host can send **pre-formatted MIDI messages** directly via Ableton's `midi_out` SDK call, bypassing the `.amxd`. That's a feature redesign, not a bug fix — defer to v0.5.9+.

### Why host code is correct

`noteNameToMidiNumber("C8") = 120` (Ableton convention C3=60). The host sends `Buffer.from([0x90, 120, velocity])` over UDP port 9000. Verified against Ableton MIDI table: MIDI 120 = C8. Host side is not the bug.


---

## Finding #10 — host UDP OK, but unpack reads a phantom leading 0 byte (STATUS OPEN, NO FIX YET)

**Captured**: 2026-07-07, user-reported via voice after my v2 .amxd fix (md5 632a836c) was installed. User confirmed:

1. **host UDP output is correct**: 3 bytes `[144, 60, 100]` for note-on C3 vel 100, `[128, 60, 0]` for note-off
2. **Max unpack shows**: `element 1 = 0` (always), `element 2 = 128 or 144`, `element 3 = 60`
3. **No MIDI is emitted** (`midiout` does nothing, no sound)

**Two hypotheses** (neither proven without Max console access):

### Hypothesis A: `udpreceive @outputformat rawbytes` prepends a 1-byte header
The patcher has `udpreceive 9000 @outputformat rawbytes`. Max's `rawbytes` mode may
add a 1-byte length/type header before each datagram. unpack 0 0 0 reads 3 ints
starting from byte 0, so it consumes [header, status, note], leaving [velocity] for
next message and shifting the rest. Would explain "element 1 = 0 always".

### Hypothesis B: Multi-datagram concatenation
When host fires note-on then note-off rapidly (press → release within <1ms), both
3-byte datagrams coalesce into a 6-byte buffer. unpack 0 0 0 reads the first 3
(status, note, velocity of the note-on) and discards the rest. Next unpack reads
nothing useful from the leftover bytes. Would also explain stuck notes.

### v3 attempt (reverted)
I built `unpack 0 0 0 0` (4 outlets, ignore the first as a lead byte) with shifted
outlet indices (+1) but **reverted** before commit. The fix assumes hypothesis A,
but if hypothesis B is correct (or both are wrong), v3 is broken too.

### Current state (REVERTED to original)
- `static/RC-Midi-Receiver.amxd` md5 `820fd477` (original 6-line patcher, status byte
  never reaches midiformat, no velocity inlet)
- `releases/Ableton-RC-Surface-0.5.8.1.ablx` rebuilt to embed the original .amxd
  (md5 `1f847ba8`)
- All `static/` files are at the ORIGINAL pre-fix state
- tag `v0.5.8.1` still points to commit `eefb660` which carries the v2 .amxd
  (md5 `632a836c`); the .ablx shipped in releases/ is now stale relative to the tag

### Why I can't self-verify
- No Max CLI on Windows host (only Max.app/Editor GUI; no headless runner)
- I cannot connect a UDP listener to port 9000 — Live's udpreceive holds the bind
- I cannot read Max console output without running Live interactively

### Recommended next step (for user)
1. Open `RC-Midi-Receiver.amxd` in Max 9.1 (the original I reverted, md5 820fd477)
2. Add a `print` or `zl slice 0 3` immediately after udpreceive to see raw bytes
3. Confirm which hypothesis is correct
4. Either way, drop the Max UI (open the patcher, save, place back in
   `User Library/Presets/MIDI Effects/Max MIDI Effect/`)
5. Tell me what bytes you saw; I'll write the correct fix and verify against
   Max's documented @outputformat semantics

### Memory note
I have made 3 attempts at this .amxd (v1 wrong outlet count, v2 correct topology
but missing lead-byte handling, v3 reverted). Each iteration took ~15 minutes
of byte-level JSON surgery. The next attempt should be done **only after seeing
the raw bytes from a real Max session**. Do NOT iterate again without ground-truth data.

