# إدارة المصنع (Factory Manager)

A single-page, no-build web app for managing fabrics, products, and production orders in a small factory/workshop. All data is stored locally in the browser (`localStorage`) — no backend or database required.

## Files

- `index.html` — page structure
- `style.css` — all styling
- `script.js` — app logic (state, rendering, events)

## Password + sync across devices (laptop, phone, etc.)

The app now supports one shared password for the whole workshop, with data synced live across every device — powered by Firebase (a free Google backend service). No server for you to run or maintain, and it still deploys as a static site (GitHub Pages works fine).

**One-time setup (~10 minutes), as the app owner:**

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a free project (any name).
2. In the project, go to **Build → Firestore Database → Create database**. Start in **production mode**, pick any region.
3. Go to the **Rules** tab of Firestore and paste in the contents of `firestore.rules.txt` (included in this folder), then **Publish**.
4. Go to **Build → Authentication → Get started**, then enable the **Email/Password** sign-in provider (just toggle it on, no further setup).
5. Go to **⚙️ Project settings → General**, scroll to "Your apps", click the **Web** icon (`</>`) to register a web app (any nickname), and copy the `firebaseConfig` object it gives you.
6. Paste those values into `firebase-config.js` in this folder, replacing the placeholder strings.
7. Deploy/open the site. The first person to open it picks a password (no email — that's only needed once, by you, to create the free Firebase project). From then on, every device just asks for that one password, and all data — fabrics, products, orders — syncs automatically between every device signed in with it.

**Notes:**
- The password can be changed anytime from the 🔑 button in the top bar (must know the current password). The 🔒 button locks the app on that device until the password is re-entered.
- Firebase's free tier (Spark plan) comfortably covers a small workshop's usage.
- Firestore documents have a 1MB size limit. If you attach a lot of large product/fabric photos, you could eventually hit that ceiling — if it comes up, the fix is moving images to Firebase Storage instead of storing them inline, which is a follow-up, not something you need to worry about today.
- If you never do this setup, the app keeps working exactly as before (local-only, no password, `localStorage` on one device).

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

- **Product number & status** — each product can have its own number/code, plus a status: "تم بالفعل" (already done — e.g. ready-made stock you already have) or "لسه هيتعمل" (still needs to be produced). Linking a product to a fabric is optional.
- **Search** on the Fabrics tab (by code or color) and the Products tab (by name, cut, or fabric). Picking a fabric when adding a product, and picking a product/cut when adding an order item, are also searchable (type to filter instead of scrolling a long list).
- **Images** — each fabric and each product can have a photo, added two ways:
  - Upload a photo from your device (resized/compressed automatically before saving).
  - Paste a direct image URL.
  - Thumbnails then show up in the Fabrics/Products tables and next to each item inside an order.
- **Search by photo (🖼️ ابحث بالصورة)** — on the Fabrics and Products tabs, next to the text search box, you can upload a photo (e.g. a picture of a roll of fabric) or paste an image URL and compare it against every saved fabric/product photo. Matches are ranked by visual similarity percentage, best match first. This runs entirely in the browser (a lightweight perceptual hash, no server or API involved), so it's fast and works offline once the page is loaded — but it needs items to already have saved photos to compare against, and images loaded from URLs on sites that block cross-origin access can't be analyzed (uploaded photos and pasted results always work).

## Notes

- Data persists per-browser via `localStorage`; clearing site data/cache will erase it. Uploaded images are stored inline as part of that data, so keep an eye on storage size if you add many photos.
- The UI is in Arabic (RTL layout).
