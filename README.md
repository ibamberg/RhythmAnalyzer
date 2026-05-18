# Rhythm Analyzer

Frontend-only rhythm analyzer for GitHub Pages.

## Run locally

Do not open `index.html` through `file://`. Browsers block ES module imports from
local files, so `src/app.js` will fail with a CORS error.

Run any tiny static server from the project root instead:

```powershell
python -m http.server 5173 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:5173/
```

## GitHub Pages

This project is static and has no backend or build step. It works on GitHub Pages
because Pages serves files over `https://`, not `file://`.

Recommended Pages setup:

1. Push the repository to GitHub.
2. Go to `Settings -> Pages`.
3. Set source to the branch root, for example `main / root`.
4. Open the published Pages URL.

## Tests

```powershell
node tests/rhythm-core.test.js
```

If `npm test` is blocked by PowerShell execution policy, run the Node command
above directly.
