const STORAGE_KEY = 'fieldnotes.spy-tracker.v1';
const hasLocalQuoteApi = ['localhost', '127.0.0.1'].includes(window.location.hostname);

const elements = {
  form: document.querySelector('#buy-form'),
  shares: document.querySelector('#shares'),
  buyPrice: document.querySelector('#buy-price'),
  buyDate: document.querySelector('#buy-date'),
  currentPrice: document.querySelector('#current-price'),
  exchangeRate: document.querySelector('#exchange-rate'),
  spyQuoteStatus: document.querySelector('#spy-quote-status'),
  fxQuoteStatus: document.querySelector('#fx-quote-status'),
  refreshQuote: document.querySelector('#refresh-quote'),
  list: document.querySelector('#buy-list'),
  emptyState: document.querySelector('#empty-state'),
  clearAll: document.querySelector('#clear-all'),
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return { buys: [], currentPrice: '', exchangeRate: '' };
    return {
      buys: Array.isArray(saved.buys) ? saved.buys.filter((buy) => Number.isFinite(buy.shares) && Number.isFinite(buy.price)) : [],
      currentPrice: saved.currentPrice ?? '',
      exchangeRate: saved.exchangeRate ?? '',
      quoteUpdatedAt: Number.isFinite(saved.quoteUpdatedAt) ? saved.quoteUpdatedAt : null,
      exchangeRateUpdatedAt: Number.isFinite(saved.exchangeRateUpdatedAt) ? saved.exchangeRateUpdatedAt : null,
    };
  } catch {
    return { buys: [], currentPrice: '', exchangeRate: '' };
  }
}

let state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function numberFrom(input) {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function money(value, currency = 'USD') {
  const symbol = currency === 'ILS' ? '₪' : '$';
  return `${symbol}${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value, currency = 'USD') {
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${money(value, currency)}`;
}

function formatDate(date) {
  if (!date) return '—';
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}

function showQuoteStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function quoteTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp * 1000));
}

function fxQuoteTime(timestamp) {
  if (hasLocalQuoteApi) return quoteTime(timestamp);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp * 1000));
}

async function refreshQuote() {
  elements.refreshQuote.disabled = true;
  if (hasLocalQuoteApi) showQuoteStatus(elements.spyQuoteStatus, 'Getting SPY quote…');
  showQuoteStatus(elements.fxQuoteStatus, 'Getting USD / ILS rate…');
  const spyQuoteRequest = hasLocalQuoteApi
    ? fetch('/api/spy-price', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('SPY quote request failed');
      return response.json();
    })
    : null;
  const fxQuoteRequest = hasLocalQuoteApi
    ? fetch('/api/usd-ils', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('USD / ILS quote request failed');
      return response.json();
    })
    : fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('USD / ILS quote request failed');
      const quote = await response.json();
      return {
        price: quote.rates?.ILS,
        currency: quote.result === 'success' && quote.base_code === 'USD' ? 'ILS' : '',
        timestamp: quote.time_last_update_unix,
      };
    });
  const requests = await Promise.allSettled([
    ...(spyQuoteRequest ? [spyQuoteRequest] : []),
    fxQuoteRequest,
  ]);

  const spyResult = hasLocalQuoteApi ? requests[0] : null;
  const fxResult = requests[hasLocalQuoteApi ? 1 : 0];
  if (spyResult?.status === 'fulfilled' && spyResult.value.currency === 'USD' && Number.isFinite(spyResult.value.price) && spyResult.value.price > 0 && Number.isFinite(spyResult.value.timestamp)) {
    elements.currentPrice.value = spyResult.value.price.toFixed(2);
    state.currentPrice = elements.currentPrice.value;
    state.quoteUpdatedAt = spyResult.value.timestamp;
    showQuoteStatus(elements.spyQuoteStatus, `SPY · ${quoteTime(spyResult.value.timestamp)}`);
  } else if (spyResult) {
    const savedTime = state.quoteUpdatedAt ? ` · saved ${quoteTime(state.quoteUpdatedAt)}` : '';
    showQuoteStatus(elements.spyQuoteStatus, `SPY unavailable${savedTime} · enter manually`, true);
  }

  if (fxResult.status === 'fulfilled' && fxResult.value.currency === 'ILS' && Number.isFinite(fxResult.value.price) && fxResult.value.price > 0 && Number.isFinite(fxResult.value.timestamp)) {
    elements.exchangeRate.value = fxResult.value.price.toString();
    state.exchangeRate = elements.exchangeRate.value;
    state.exchangeRateUpdatedAt = fxResult.value.timestamp;
    showQuoteStatus(elements.fxQuoteStatus, `USD / ILS · ${fxQuoteTime(fxResult.value.timestamp)}`);
  } else {
    const savedTime = state.exchangeRateUpdatedAt ? ` · saved ${fxQuoteTime(state.exchangeRateUpdatedAt)}` : '';
    showQuoteStatus(elements.fxQuoteStatus, `USD / ILS unavailable${savedTime} · enter manually`, true);
  }

  saveState();
  render();
  elements.refreshQuote.disabled = false;
}

function render() {
  const currentPrice = numberFrom(elements.currentPrice);
  const exchangeRate = numberFrom(elements.exchangeRate);
  const shares = state.buys.reduce((total, buy) => total + buy.shares, 0);
  const invested = state.buys.reduce((total, buy) => total + buy.shares * buy.price, 0);
  const currentValue = currentPrice ? shares * currentPrice : 0;
  const profit = currentPrice ? currentValue - invested : 0;
  const returnPercent = invested && currentPrice ? (profit / invested) * 100 : 0;

  document.querySelector('#return-percent').textContent = `${returnPercent.toFixed(2)}%`;
  document.querySelector('#return-percent').classList.toggle('negative', returnPercent < 0);
  document.querySelector('#profit-usd').textContent = signedMoney(profit);
  document.querySelector('#profit-usd').classList.toggle('negative', profit < 0);
  document.querySelector('#profit-ils').textContent = signedMoney(profit * exchangeRate, 'ILS');
  document.querySelector('#profit-ils').classList.toggle('negative', profit < 0);
  document.querySelector('#average-price').textContent = money(shares ? invested / shares : 0);
  document.querySelector('#shares-caption').textContent = `Across ${shares.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${shares === 1 ? 'share' : 'shares'}`;
  document.querySelector('#invested-value').textContent = money(invested);
  document.querySelector('#current-value').textContent = money(currentValue);
  document.querySelector('#lot-count').textContent = state.buys.length.toString();
  document.querySelector('#heading-count').textContent = `(${state.buys.length})`;

  elements.list.replaceChildren();
  for (const buy of [...state.buys].sort((first, second) => second.date.localeCompare(first.date))) {
    const row = document.createElement('tr');
    const buyValue = buy.shares * buy.price;
    const lotValue = currentPrice ? buy.shares * currentPrice : 0;
    const lotProfit = currentPrice ? lotValue - buyValue : 0;
    const lotReturn = buyValue && currentPrice ? (lotProfit / buyValue) * 100 : 0;
    const cells = [
      { text: formatDate(buy.date), className: 'date-cell' },
      { text: buy.shares.toLocaleString('en-US', { maximumFractionDigits: 6 }), className: 'numeric' },
      { text: money(buy.price), className: 'numeric' },
      { text: money(buyValue), className: 'numeric' },
      { text: currentPrice ? money(lotValue) : '—', className: 'numeric' },
      { text: currentPrice ? `${lotReturn > 0 ? '+' : ''}${lotReturn.toFixed(2)}%` : '—', className: `numeric return-cell ${lotReturn < 0 ? 'negative' : 'positive'}` },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      td.className = cell.className;
      row.append(td);
    }
    const actionCell = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove buy of ${buy.shares} shares at ${money(buy.price)}`);
    remove.addEventListener('click', () => {
      state.buys = state.buys.filter((item) => item.id !== buy.id);
      saveState();
      render();
    });
    actionCell.append(remove);
    row.append(actionCell);
    elements.list.append(row);
  }

  const isEmpty = state.buys.length === 0;
  elements.emptyState.classList.toggle('visible', isEmpty);
  elements.list.hidden = isEmpty;
  elements.clearAll.hidden = isEmpty;
  document.querySelector('#return-caption').textContent = currentPrice ? 'Based on your invested amount' : 'Enter a SPY price to see your return';
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const shares = numberFrom(elements.shares);
  const price = numberFrom(elements.buyPrice);
  if (!shares || !price) return;
  state.buys.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    shares,
    price,
    date: elements.buyDate.value || new Date().toISOString().slice(0, 10),
  });
  saveState();
  elements.form.reset();
  render();
  elements.shares.focus();
});

for (const input of [elements.currentPrice, elements.exchangeRate]) {
  input.addEventListener('input', () => {
    state.currentPrice = elements.currentPrice.value;
    state.exchangeRate = elements.exchangeRate.value;
    if (input === elements.currentPrice) {
      state.quoteUpdatedAt = null;
      showQuoteStatus(elements.spyQuoteStatus, 'Manual SPY price');
    } else {
      state.exchangeRateUpdatedAt = null;
      showQuoteStatus(elements.fxQuoteStatus, 'Manual USD / ILS rate');
    }
    saveState();
    render();
  });
}

elements.refreshQuote.addEventListener('click', refreshQuote);

elements.clearAll.addEventListener('click', () => {
  if (!window.confirm('Remove all SPY buys? This cannot be undone.')) return;
  state.buys = [];
  saveState();
  render();
});

elements.currentPrice.value = state.currentPrice;
elements.exchangeRate.value = state.exchangeRate;
if (state.quoteUpdatedAt) showQuoteStatus(elements.spyQuoteStatus, `Saved SPY · ${quoteTime(state.quoteUpdatedAt)}`);
if (state.exchangeRateUpdatedAt) showQuoteStatus(elements.fxQuoteStatus, `Saved USD / ILS · ${fxQuoteTime(state.exchangeRateUpdatedAt)}`);
if (!hasLocalQuoteApi) {
  showQuoteStatus(elements.spyQuoteStatus, 'Enter SPY price manually');
  showQuoteStatus(elements.fxQuoteStatus, 'Fetching USD / ILS rate…');
}
render();
refreshQuote();
if (hasLocalQuoteApi) window.setInterval(refreshQuote, 5 * 60 * 1000);