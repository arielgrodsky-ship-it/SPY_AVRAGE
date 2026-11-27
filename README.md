# SPY Buy Tracker

A browser-based tracker for SPY buy lots, portfolio value, and estimated returns in USD and ILS. Data is saved in the current browser and can optionally sync between devices through Firebase.

## Portfolio features and backups

- Export or import a timestamped JSON backup of buy lots, market values, and logged dividends. Imports are validated and can replace or merge with current entries.
- An optional USD / ILS rate is saved with each new buy. Older lots without a purchase rate use the current rate for ILS calculations.
- The estimated Israeli capital-gains tax applies 25% to gains remaining after the purchase-to-current USD / ILS adjustment. This is only an estimate: it does not fetch CPI data, account for fees or other tax rules, or replace professional tax advice.
- Log dividend amounts as received to include them in total returns. Reinvested is recorded for reference and does not change share counts; add a buy lot separately when shares are purchased.
- A chart shows cumulative average cost, individual purchase prices, and the current SPY price.

The original `fieldnotes.spy-tracker.v1` browser-storage key remains in use for buys and market settings. Dividends are stored separately under `fieldnotes.spy-tracker.dividends.v1`.

- Sign in with Google to sync the existing buy lots, dividends, and settings to one owner-only Firestore document. Local storage remains the working copy and supports offline use. The first sign-in uploads local data if the cloud is empty; if both sides have tracker entries, choose cloud, device, or merge.
- A separate `fieldnotes.spy-tracker.sync-owner.v1` key records only the last synced account ID; it prevents accidentally uploading one account's local portfolio to a different Google account.

## Enable cross-device sync

1. Open [Firebase Console](https://console.firebase.google.com/) and create a project.
2. In **Build → Authentication → Sign-in method**, enable **Google** and choose a support email.
3. In **Build → Firestore Database**, create a database.
4. Open **Firestore Database → Rules**, replace the rules with the contents of [`firestore.rules`](./firestore.rules), and publish them. These rules restrict reads and writes to the authenticated owner of each `/users/{uid}/...` path.
5. In **Authentication → Settings → Authorized domains**, add your deployed site host (for GitHub Pages this is usually `<account>.github.io`; also add a custom domain if you use one). For local development, add `localhost` and/or `127.0.0.1`, matching the host in the URL you use.
6. In **Project settings → General → Your apps**, register a Web app if needed and copy its Firebase web config. Paste the `apiKey`, `authDomain`, `projectId`, and `appId` values into [`firebase-config.js`](./firebase-config.js), replacing the empty strings. This web config is public client configuration, not an admin key; never put service-account credentials in the site.
7. Deploy the site, then use **Sign in with Google** on both devices with the same account. If both devices already contain tracker entries, choose how to resolve them on first sync.

The app loads Firebase Web SDK **10.12.5** from the official Firebase CDN. Signing out or being offline does not disable local tracking. Changes are saved to local storage immediately and queued for cloud sync when connected. Export/Import JSON remains available as a manual backup.

## Run locally

Requires Python 3. From this folder, run:

```powershell
python server.py
```

Open <http://127.0.0.1:8000/>. Press `Ctrl+C` in the terminal to stop the server.

The local server provides automatic SPY and USD / ILS quotes. Quotes require an internet connection and may occasionally be unavailable.

## Publish on GitHub Pages

1. Create a GitHub repository and upload/push these project files to its `main` branch.
2. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` deploys the site after pushes to `main`. You can also start it from the repository's **Actions** tab.
4. Once the workflow completes, open the Pages URL shown in **Settings → Pages**.

GitHub Pages hosts the tracker as a static site; it cannot run the Python quote server. The deployment workflow fetches the SPY quote and republishes it about every 15 minutes. The page also refreshes the quote while open and when you use the refresh button. USD / ILS is fetched online from ExchangeRate-API when the page loads; rates are updated daily. Buys and entered values remain in that browser's local storage, with optional Firebase sync when configured.