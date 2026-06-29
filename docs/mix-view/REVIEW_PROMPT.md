# Mix View — Independent Review Prompt (v0.3.1)

You are an independent reviewer. The author (ARGOS, acting on
behalf of worm / ntworm) has prepared a spec and plan for a new
"Mix View" feature in the Ableton RC Bridge project. The project
turns a phone into a mappable Ableton controller via a Live
extension. The new feature adds a second, optional web client that
reads the live Ableton set structure and renders a mobile mixing
UI.

## Context to read (in this order)

1. `README.md` — project overview, scope, what is shipped today.
2. `docs/INSTALL.md` — installation and HTTPS flow.
3. `manifest.json`, `package.json` — versioning.
4. `docs/mix-view/SPEC.md` — the feature specification.
5. `docs/mix-view/PLAN.md` — the phased implementation plan.
6. `docs/mix-view/REVIEW_PROMPT.md` — this file.

## What to review

Focus on the structure and the concept, not the wording.
Specifically:

- Does SPEC.md cover the goals and non-goals unambiguously?
- Is the additive-only constraint clearly preserved (no change
  to v0.3.0 behaviour)?
- Is the dual QR code + mode flag model coherent? Are there
  foot-guns (token reuse, mode confusion, certificate
  contention)?
- Is the Generic-template-first approach sound, or is there a
  risk that the Generic template masks device-specific issues
  that would have surfaced earlier with specialised templates?
- Are the phased plan's gates and dependencies realistic for a
  solo developer working in a single repo?
- Are the open questions in SPEC.md §15 answerable, or do they
  indicate missing structure?
- Are the failure modes in SPEC.md §14 sufficient, or are there
  missing ones? (Consider: track rename, device deletion, zero
  tracks, read-only parameters, very large sessions, two phones
  writing simultaneously, the user opening Mix View while
  Performance View is being mapped, the user killing the Live
  process while the phone is open, the user reloading the
  phone's page while a command is in flight.)

## What NOT to review

- Wording, grammar, or naming style.
- Code style, since no code exists yet.
- Performance numbers, since the spec only mentions budgets and
  not measured values.
- Marketing or release channel decisions (GitHub vs site vs
  Discord). These are downstream of the spec.

## How to respond

Return exactly one of:

- `PASS` — the spec and plan are good as written.
- `PASS-WITH-NITS` — the spec and plan are good; here is a list
  of non-blocking suggestions.
- `CONCERNS` — the spec or plan has structural issues that should
  be resolved before any code is written. List the concerns.
- `REJECT` — the spec or plan has a fundamental problem. State
  it plainly.

## Response format

A short verdict line, followed by:

- For each concern, cite the file and section (e.g.
  `SPEC.md §8.1, fourth bullet`).
- For each open question you would answer, prefix the line with
  `OPEN-Q-RESOLVED:` followed by the answer.
- For each missing failure mode you would add, prefix the line
  with `MISSING-FAILURE-MODE:` followed by the scenario and a
  sketch of the expected behaviour.
- For each non-blocking suggestion, prefix the line with `NIT:`.

## Ground rules

- Read-only review. Do not modify any file.
- If you would change the version number (e.g. 0.3.1 -> 0.4.0),
  say so and explain why.
- If you would split or merge phases, propose a concrete diff
  of the phase list.
- If you would remove or add an open question, say which and
  why.
- If you would re-categorise a "Missing failure mode" as
  "Already handled in §N", point to the existing handling.

## Why this review exists

The author is biased. The author has the full context, the full
intent, and a strong incentive to ship. A fresh pair of eyes
catches structural issues that the author rationalises away.
Read the spec as if you were going to implement it next week
without any further input from the author.
