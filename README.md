# SPY Buy Tracker

A browser-based tracker for SPY buy lots, portfolio value, and estimated returns in USD and ILS. Buy data is saved in the current browser and is not synced between devices.

## Portfolio features and backups

- Export or import a timestamped JSON backup of buy lots, market values, and logged dividends. Imports are validated and can replace or merge with current entries.
- An optional USD / ILS rate is saved with each new buy. Older lots without a purchase rate use the current rate for ILS calculations.
- The estimated Israeli capital-gains tax applies 25% to gains remaining after the purchase-to-current USD / ILS adjustment. This is only an estimate: it does not fetch CPI data, account for fees or other tax rules, or replace professional tax advice.
- Log dividend amounts as received to include them in total returns. Reinvested is recorded for reference and does not change share counts; add a buy lot separately when shares are purchased.
- A chart shows cumulative average cost, individual purchase prices, and the current SPY price.

The original `fieldnotes.spy-tracker.v1` browser-storage key remains in use for buys and market settings. Dividends are stored separately under `fieldnotes.spy-tracker.dividends.v1`.

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

GitHub Pages hosts the tracker as a static site; it cannot run the Python quote server. The deployment workflow fetches the SPY quote and republishes it about every 15 minutes. The page also refreshes the quote while open and when you use the refresh button. USD / ILS is fetched online from ExchangeRate-API when the page loads; rates are updated daily. Buys and entered values remain in that browser's local storage.