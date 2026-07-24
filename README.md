# إدارة المصنع (Factory Manager)

A single-page, no-build web app for managing fabrics, products, and production orders in a small factory/workshop. All data is stored locally in the browser (`localStorage`) — no backend or database required.

## Files

- `index.html` — page structure
- `style.css` — all styling
- `script.js` — app logic (state, rendering, events)

## Running locally

Just open `index.html` in a browser, or serve the folder with any static server, e.g.:

```bash
npx serve .
# or
python3 -m http.server
```

## Deploying with GitHub Pages

1. Push these files to a GitHub repo.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`, pick your branch (e.g. `main`) and the `/ (root)` folder.
4. Save — your app will be live at `https://<username>.github.io/<repo-name>/`.

## Features

- **Search** on the Fabrics tab (by code or color) and the Products tab (by name, cut, or fabric). Picking a fabric when adding a product, and picking a product/cut when adding an order item, are also searchable (type to filter instead of scrolling a long list).
- **Images** — each fabric and each product can have a photo, added three ways:
  - Upload a photo from your device (resized/compressed automatically before saving).
  - Paste a direct image URL.
  - Use **"🔍 بحث عن صورة"** to search openly-licensed photos (via the [Openverse](https://openverse.org) API, no key required) and pick one with a click.
  - Thumbnails then show up in the Fabrics/Products tables and next to each item inside an order.
- **Search by photo (🖼️ ابحث بالصورة)** — on the Fabrics and Products tabs, next to the text search box, you can upload a photo (e.g. a picture of a roll of fabric) or paste an image URL and compare it against every saved fabric/product photo. Matches are ranked by visual similarity percentage, best match first. This runs entirely in the browser (a lightweight perceptual hash, no server or API involved), so it's fast and works offline once the page is loaded — but it needs items to already have saved photos to compare against, and images loaded from URLs on sites that block cross-origin access can't be analyzed (uploaded photos and pasted Openverse/Wikimedia results always work).

## Notes

- Data persists per-browser via `localStorage`; clearing site data/cache will erase it. Uploaded images are stored inline as part of that data, so keep an eye on storage size if you add many photos.
- The in-app image search calls `api.openverse.org` directly from the browser — it needs an internet connection and won't work if that request is blocked (e.g. some corporate networks). Uploading a file or pasting a URL always works offline-safe by comparison (URL images still need the internet to load, but don't depend on that specific API).
- The UI is in Arabic (RTL layout).
