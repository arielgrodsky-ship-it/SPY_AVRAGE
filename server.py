import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
QUOTE_TICKERS = {
    "/api/spy-price": "SPY",
    "/api/usd-ils": "ILS=X",
}


def fetch_quote(ticker):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1d&interval=1m"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urlopen(request, timeout=10) as response:
        payload = json.load(response)
    metadata = payload["chart"]["result"][0]["meta"]
    return {
        "price": float(metadata["regularMarketPrice"]),
        "currency": metadata["currency"],
        "timestamp": int(metadata["regularMarketTime"]),
    }


class TrackerHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        ticker = QUOTE_TICKERS.get(self.path.split("?", 1)[0])
        if ticker is None:
            return super().do_GET()

        try:
            body = json.dumps(fetch_quote(ticker)).encode("utf-8")
            self.send_response(200)
        except (URLError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
            body = json.dumps({"error": f"{ticker} quote is currently unavailable"}).encode("utf-8")
            self.send_response(502)

        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    handler = partial(TrackerHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 8000), handler)
    print("SPY Buy Tracker running at http://127.0.0.1:8000/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()