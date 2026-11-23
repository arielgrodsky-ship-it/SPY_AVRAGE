# SPY Buy Tracker

A browser-based tracker for SPY buy lots, portfolio value, and estimated returns in USD and ILS. Buy data is saved in the current browser and is not synced between devices.

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

GitHub Pages hosts the tracker as a static site; it cannot run the Python quote server. The USD / ILS reference rate is fetched online from Frankfurter (ECB reference rates) when the page loads; use the refresh button to update it. Enter the SPY price manually. Buys and entered values remain in that browser's local storage.