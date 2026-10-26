# README assets

Images used by the repository README. This folder holds documentation images only; no app code reads from it.

| File | What it is | How it was made |
| --- | --- | --- |
| `banner-light.png`, `banner-dark.png` | README banner for light and dark GitHub themes | Rendered from an HTML template with headless Chromium, using the logo in `assets/brand/` |
| `hero.png` | The app on desktop and phone | Real screenshot of `npm run dev` on localhost with no API key, framed in a browser window and phone outline |
| `screenshots/approval.png`, `screenshots/needs-input.png`, `screenshots/result.png` | Individual task cards | Real element screenshots of the same local app |

The task cards show **synthetic demo tasks** written into the git-ignored local store (`.data/tasks.json`) for the screenshot. `salon.example.com` and `example.com` are placeholder domains.

## Notes for agents

- Screenshots must show only public or synthetic demo data: never real API keys, accounts, personal requests or private browsing.
- Regenerate screenshots from the running app rather than editing images by hand.
- Keep file names stable; the root README links to them.
