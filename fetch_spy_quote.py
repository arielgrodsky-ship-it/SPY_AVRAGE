import json
import math

from server import fetch_quote


quote = fetch_quote("SPY")
if quote["currency"] != "USD" or not math.isfinite(quote["price"]) or quote["price"] <= 0:
    raise ValueError("SPY quote is invalid")

print(json.dumps(quote))
