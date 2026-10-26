# Banner source

`banner.html` is the editable source of `../banner-light.png` and `../banner-dark.png`.

- **What it is:** a self-contained HTML page at 1600 × 600 that loads Google Fonts and the logo from `../../../assets/brand/logo.png`. A `prefers-color-scheme: dark` media query holds the dark variant.
- **How to change it:** edit the text, colors (CSS variables at the top) or the inline SVG motif, then render both schemes at 2× scale (see `../README.md`). Check both PNGs for overflow and contrast before committing.
- **Naming:** keep `banner.html` and the two PNG names stable; the root README links to the PNGs.

## Notes for agents

- The banner must stay honest: keep status wording (prototype, concept, fictional data) in sync with the root README.
- Use only public, synthetic or fictional content. No personal data, keys or real user records.
- No app code reads this folder.
