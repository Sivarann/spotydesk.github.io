# SpotyDesk — *full original Turntable* with optional Canvas videos

This project is an **additive integration for Peekabu411's original Turntable**, not the simplified independent Nightdeck/SpotyDesk clone. The build fetches/copies **the complete original repository** and adds three small files and two hooks, retaining its original Spotify authentication, playlists, queue, synced lyrics, settings, device control and landscape UI. It updates the original redirect URL to `https://spotydesk.github.io/` and updates its cache so the phone gets the new code.

**Important:** This zip contains the *integration and deployment workflow*, not a copy of the full original Turntable code. This session could not download that repository to merge it here. The GitHub Actions build attempts to fetch the full original from `https://github.com/peekabu411/peekabu411.github.io` when you deploy. If the original has been moved or access is restricted, put the complete authorised original source into an `original-turntable/` folder inside your own repository. The build refuses to publish a partial source or to silently guess changed code locations. You say you have a licence to reuse the original; keep its licence and attribution files when publishing.

## Deploy on the spotydesk GitHub account (Android compatible)

1. Sign into the GitHub account **`spotydesk`**. Create `spotydesk.github.io` if needed. If this is a different account name, change `USER_ADDRESS` inside `scripts/build.py` accordingly.
2. Extract this ZIP. Upload the **contents** of the extracted folder to the root of the `spotydesk.github.io` repository, including the hidden `.github/workflows/pages.yml` directory. You can use Android's Files app and GitHub's web upload, or upload using a desktop if easier. Do not upload only the ZIP.
3. In your GitHub repository, open **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Go to **Actions → Deploy original Turntable + SpotyDesk Canvas overlay → Run workflow**, if it did not run automatically after your commit. GitHub will fetch the original full code, apply the add-on and publish it. The address will be `https://spotydesk.github.io/` once deployment succeeds.
5. On Android, open the URL in Chrome and select **Add to Home screen**. The original setup guide should show your site's URL as the Spotify OAuth Redirect URI; add it to your **own** Spotify Developer app. Use only the Spotify Client ID, not the Client Secret.

## Automatic Canvas video backgrounds

The video lookup calls a **separate, trusted HTTPS Canvas API**, compatible with [Paxsenix0/Spotify-Canvas-API](https://github.com/Paxsenix0/Spotify-Canvas-API). Its documented endpoint is `GET /api/canvas?trackId=...`, returning `data.canvasesList[].canvasUrl`.

- GitHub Pages cannot host the Canvas API's Node.js backend. The original API needs a sensitive Spotify `sp_dc` session cookie **on its server**, which must **never** be put in the website, a GitHub repository or this chat.
- After you have a running trusted backend, go to your `spotydesk.github.io` GitHub repository → **Settings → Secrets and variables → Actions → Variables** and create **`CANVAS_API_URL`** with a public HTTPS URL ending in `/api/canvas`, such as `https://YOUR-SERVER.example/api/canvas`. This is a public URL, never a cookie or secret. Run the GitHub workflow again.
- Your Canvas backend must set CORS `Access-Control-Allow-Origin: https://spotydesk.github.io`. The original API sample doesn't add this header automatically. If it does not support CORS, Chrome will reject the request.
- The site's Content Security Policy is updated to allow that configured API host and video playback from `https://canvaz.scdn.co`. The browser sends **only the Spotify track ID** to your API, never the website's Spotify OAuth token.
- When there is a Canvas URL (HTTPS `canvaz.scdn.co` MP4), it plays **muted, looping and inline** behind the original UI. Pausing playback pauses the video. If there's no Canvas, an API error or an unplayable video, the existing Turntable artwork background remains. The video doesn't replace Spotify audio.
- You can switch Canvas on/off in the original Settings tab under "Automatic Spotify Canvas backgrounds" if that panel exists in the upstream version.
- Optional licensed local videos can be specified in `overlay/video-loops.json` as `{ "spotify:track:ID": "./videos/clip.mp4" }`, and stored in `overlay/videos/`. Local mappings override automatic Canvas lookup.

**No working Canvas backend is included or connected**. Without the `CANVAS_API_URL` variable, everything in original Turntable still functions and no Canvas network request is made.

## Compatibility, rights and privacy

The Spotify Web API does not officially expose Canvas. Paxsenix0's repository calls undocumented Spotify services and warns that using them may breach Spotify's terms. The API server should be used only where authorised and supported. Also check Spotify's rules on visual synchronisation before using Canvas with playback. This project copies **no third-party Canvas backend code** and adds no cookies or private tokens to the site.

The original upstream may change. The patch checks exact integration points in `app.js` and `bridge.js`, rather than deleting or rewriting features; if they change, the GitHub workflow fails visibly instead of publishing a broken mix. This integration was tested using a **representative upstream fixture**, not the actual repo or a live Spotify account. An end-to-end Android/Spotify/Canvas check will still be needed after deployment.

## Run the build on a machine with the original source

```sh
python3 scripts/build.py ./original-turntable ./_site
```

A successful build gives a ready-to-publish `_site/` folder containing the original site plus the add-on. This is also what the included GitHub Actions workflow publishes.
