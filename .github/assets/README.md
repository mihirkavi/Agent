# README assets

Images used by the repository README. This folder holds documentation images only; no app code reads from it.

| File | What it is | How it was made |
| --- | --- | --- |
| `banner-light.png`, `banner-dark.png` | README banner for light and dark GitHub themes | Rendered with headless Chromium from `source/banner.html` (one file with a dark-mode variant), using the logo in `assets/brand/` |
| `hero.png` | The app on desktop and phone | Real screenshot of `npm run dev` on localhost with no API key, framed in a browser window and phone outline |
| `screenshots/approval.png`, `screenshots/needs-input.png`, `screenshots/result.png` | Individual task cards | Real element screenshots of the same local app |

The task cards show **synthetic demo tasks** written into the git-ignored local store (`.data/tasks.json`) for the screenshot. `salon.example.com` and `example.com` are placeholder domains.

## Visual identity

The banner and README styling follow Voice Operator's own brand rather than a shared template.

- **Fonts:** **Figtree** (display, the closest Google Fonts match to the app's Avenir Next headings), **IBM Plex Sans** (body, the app's own body font) and **IBM Plex Mono** (tool names). All from Google Fonts.
- **Colors:** midnight `#0C1220` / `#08101C` gradient, coral `#FF8D5D`, amber `#FFD168`, success green `#6CE39B` (dark); warm cream `#FBF6EF` with deeper coral `#D9572A` and amber `#A86F08` for contrast (light). All taken from `src/styles.css`.
- **Motif:** A live-console waveform that hands off through `delegate_task()` to three task cards showing the app's real statuses (Running, Needs approval, Needs input). The task titles are the synthetic demo tasks used in the screenshots.
- **Layout:** Left-aligned split on the app's radial coral and amber glow, matching the running app rather than a generic template.
- **Badges:** shields.io flat-square in `0C1220` (stack) and `D9572A` (status, license).

To re-render, use any Playwright-based HTML-to-PNG script at a 1600 × 600 viewport and 2× scale, once per color scheme. With the README kit's `render-html.mjs`:

```bash
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
node render-html.mjs .github/assets/source/banner.html .github/assets/banner-light.png --scheme light
node render-html.mjs .github/assets/source/banner.html .github/assets/banner-dark.png --scheme dark
```

## Notes for agents

- Screenshots must show only public or synthetic demo data: never real API keys, accounts, personal requests or private browsing.
- Regenerate screenshots from the running app rather than editing images by hand.
- Keep file names stable; the root README links to them.
