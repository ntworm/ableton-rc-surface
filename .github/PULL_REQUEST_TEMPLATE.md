## Summary

One or two sentences. Link the issue (if any) with `Closes #<id>` or `Refs #<id>`.

## What changed

- [ ] (bullet of the user-visible behavior change)
- [ ] (another)

## Test plan

- [ ] `npm run ci` — lint, typecheck, test, build all green
- [ ] Manually tested on: ___
- [ ] For sensor / QR / mapping changes: also tested on Android and iOS if available

## Screenshots / screen recordings

(Required for UI changes. Attach or describe what to expect visually.)

## CHANGELOG.md

- [ ] I added an entry under the **next** version (`Unreleased` or the in-progress version).
- [ ] Entry uses the format `### Added / ### Changed / ### Fixed / ### Removed`.

## Breaking changes

- [ ] No breaking changes
- [ ] Breaking: describe what consumers need to do

## Checklist

- [ ] Read `CONTRIBUTING.md` (code structure, style, focus)
- [ ] No debug `console.log` left in production paths
- [ ] No new `.ablx` / `dist/` artifacts added to the PR
- [ ] Commits are focused with clear messages
- [ ] No secrets (`*.pem`, `.certs/`, `.env`) committed
