const STORAGE_KEY = 'fieldnotes.spy-tracker.v1';
const DIVIDEND_STORAGE_KEY = 'fieldnotes.spy-tracker.dividends.v1';
const hasLocalQuoteApi = ['localhost', '127.0.0.1'].includes(window.location.hostname);
let stateWritable = true;
let dividendsWritable = true;

const elements = {
  form: document.querySelector('#buy-form'),
  shares: document.querySelector('#shares'),
  buyPrice: document.querySelector('#buy-price'),
  buyDate: document.querySelector('#buy-date'),
  buyExchangeRate: document.querySelector('#buy-exchange-rate'),
  currentPrice: document.querySelector('#current-price'),
  exchangeRate: document.querySelector('#exchange-rate'),
  spyQuoteStatus: document.querySelector('#spy-quote-status'),
  fxQuoteStatus: document.querySelector('#fx-quote-status'),
  refreshQuote: document.querySelector('#refresh-quote'),
  list: document.querySelector('#buy-list'),
  emptyState: document.querySelector('#empty-state'),
  clearAll: document.querySelector('#clear-all'),
  exportBackup: document.querySelector('#export-backup'),
  importBackup: document.querySelector('#import-backup'),
  backupFile: document.querySelector('#backup-file'),
  saveStatus: document.querySelector('#save-status'),
  dividendForm: document.querySelector('#dividend-form'),
  dividendDate: document.querySelector('#dividend-date'),
  dividendAmount: document.querySelector('#dividend-amount'),
  dividendReinvested: document.querySelector('#dividend-reinvested'),
  dividendList: document.querySelector('#dividend-list'),
  dividendEmpty: document.querySelector('#dividend-empty'),
};

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const saved = JSON.parse(stored);
    if (stored !== null && (!saved || typeof saved !== 'object' || Array.isArray(saved))) throw new Error('Invalid saved tracker data');
    if (saved?.buys !== undefined && !Array.isArray(saved.buys)) throw new Error('Invalid saved buy lots');
    const buys = Array.isArray(saved?.buys) ? saved.buys.filter(isValidBuy) : [];
    if (buys.length !== (saved?.buys?.length ?? 0)) throw new Error('Some saved buy lots could not be read');
    if (!isValidQuote(saved?.currentPrice) || !isValidQuote(saved?.exchangeRate)) throw new Error('Invalid saved market values');
    return {
      buys,
      currentPrice: saved?.currentPrice ?? '',
      exchangeRate: saved?.exchangeRate ?? '',
      quoteUpdatedAt: Number.isFinite(saved?.quoteUpdatedAt) ? saved.quoteUpdatedAt : null,
      exchangeRateUpdatedAt: Number.isFinite(saved?.exchangeRateUpdatedAt) ? saved.exchangeRateUpdatedAt : null,
    };
  } catch {
    stateWritable = false;
    return { buys: [], currentPrice: '', exchangeRate: '' };
  }
}

let state = loadState();

function loadDividends() {
  try {
    const stored = localStorage.getItem(DIVIDEND_STORAGE_KEY);
    if (stored === null) return [];
    const saved = JSON.parse(stored);
    if (!Array.isArray(saved) || saved.some((entry) => !isValidDividend(entry))) throw new Error('Invalid saved dividends');
    return saved;
  } catch {
    dividendsWritable = false;
    return [];
  }
}

let dividends = loadDividends();

function saveState() {
  if (!stateWritable) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    stateWritable = false;
    updateSaveStatus();
    return false;
  }
}

function saveDividends() {
  if (!dividendsWritable) return false;
  try {
    localStorage.setItem(DIVIDEND_STORAGE_KEY, JSON.stringify(dividends));
    return true;
  } catch {
    dividendsWritable = false;
    updateSaveStatus();
    return false;
  }
}

function updateSaveStatus() {
  const canWrite = stateWritable && dividendsWritable;
  elements.saveStatus.lastChild.textContent = canWrite
    ? ' Saved on this device'
    : ' Saved data could not be read or written. Import a valid backup to continue.';
  elements.saveStatus.classList.toggle('save-error', !canWrite);
  elements.exportBackup.disabled = !stateWritable || !dividendsWritable;
  elements.form.querySelector('button[type="submit"]').disabled = !stateWritable;
  elements.dividendForm.querySelector('button[type="submit"]').disabled = !dividendsWritable;
  for (const input of elements.form.querySelectorAll('input')) input.disabled = !stateWritable;
  for (const input of elements.dividendForm.querySelectorAll('input')) input.disabled = !dividendsWritable;
  for (const input of [elements.currentPrice, elements.exchangeRate]) input.disabled = !stateWritable;
  elements.clearAll.disabled = !stateWritable;
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

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidBuy(buy) {
  return Boolean(
    buy
    && typeof buy === 'object'
    && typeof buy.id === 'string'
    && buy.id
    && Number.isFinite(buy.shares)
    && buy.shares > 0
    && Number.isFinite(buy.price)
    && buy.price > 0
    && isValidDate(buy.date)
    && (buy.purchaseExchangeRate === undefined || (Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0)),
  );
}

function isValidDividend(dividend) {
  return Boolean(
    dividend
    && typeof dividend === 'object'
    && typeof dividend.id === 'string'
    && dividend.id
    && isValidDate(dividend.date)
    && Number.isFinite(dividend.amount)
    && dividend.amount > 0
    && (dividend.reinvested === undefined || typeof dividend.reinvested === 'boolean'),
  );
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value);
  return element;
}

function drawPriceChart() {
  const svg = document.querySelector('#price-chart');
  const empty = document.querySelector('#chart-empty');
  const buys = [...state.buys].sort((first, second) => (first.date || '').localeCompare(second.date || ''));
  svg.replaceChildren(svg.querySelector('desc'));
  svg.hidden = buys.length === 0;
  empty.hidden = buys.length > 0;
  if (!buys.length) return;

  const plot = { left: 62, right: 760, top: 24, bottom: 244 };
  const values = buys.map((buy) => buy.price);
  const currentPrice = numberFrom(elements.currentPrice);
  if (currentPrice) values.push(currentPrice);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = Math.max((high - low) * 0.12, high * 0.015, 0.5);
  const minPrice = Math.max(0, low - padding);
  const maxPrice = high + padding;
  const dateValues = buys.map((buy) => isValidDate(buy.date) ? new Date(`${buy.date}T00:00:00Z`).getTime() : NaN);
  const validDates = dateValues.every(Number.isFinite);
  const firstDate = validDates ? Math.min(...dateValues) : 0;
  const lastDate = validDates ? Math.max(...dateValues) : Math.max(buys.length - 1, 1);
  const xFor = (index) => {
    const time = validDates ? dateValues[index] : index;
    return firstDate === lastDate ? (plot.left + plot.right) / 2 : plot.left + ((time - firstDate) / (lastDate - firstDate)) * (plot.right - plot.left);
  };
  const yFor = (price) => plot.bottom - ((price - minPrice) / (maxPrice - minPrice)) * (plot.bottom - plot.top);

  for (let tick = 0; tick <= 4; tick += 1) {
    const y = plot.top + ((plot.bottom - plot.top) * tick) / 4;
    const amount = maxPrice - ((maxPrice - minPrice) * tick) / 4;
    svg.append(svgElement('line', { x1: plot.left, x2: plot.right, y1: y, y2: y, class: 'chart-gridline' }));
    const label = svgElement('text', { x: plot.left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = `$${amount.toFixed(0)}`;
    svg.append(label);
  }

  if (currentPrice) {
    const y = yFor(currentPrice);
    svg.append(svgElement('line', { x1: plot.left, x2: plot.right, y1: y, y2: y, class: 'chart-market-line' }));
    const label = svgElement('text', { x: plot.right - 2, y: y - 7, 'text-anchor': 'end', class: 'chart-market-label' });
    label.textContent = `Market $${currentPrice.toFixed(2)}`;
    svg.append(label);
  }

  let runningShares = 0;
  let runningCost = 0;
  const averagePoints = buys.map((buy, index) => {
    runningShares += buy.shares;
    runningCost += buy.shares * buy.price;
    return { x: xFor(index), y: yFor(runningCost / runningShares) };
  });
  const path = averagePoints.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  svg.append(svgElement('path', { d: path, class: 'chart-average-line' }));
  for (let index = 0; index < buys.length; index += 1) {
    svg.append(svgElement('circle', { cx: xFor(index), cy: yFor(buys[index].price), r: 4, class: 'chart-purchase-point' }));
  }
  for (const point of averagePoints) svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: 3, class: 'chart-average-point' }));

  const firstLabel = svgElement('text', { x: plot.left, y: 272, 'text-anchor': 'start', class: 'chart-axis-label' });
  firstLabel.textContent = formatDate(buys[0].date);
  svg.append(firstLabel);
  if (buys.length > 1) {
    const lastLabel = svgElement('text', { x: plot.right, y: 272, 'text-anchor': 'end', class: 'chart-axis-label' });
    lastLabel.textContent = formatDate(buys[buys.length - 1].date);
    svg.append(lastLabel);
  }
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
    : fetch(`./spy-price.json?${Date.now()}`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('SPY quote request failed');
      return response.json();
    });
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
  const requests = await Promise.allSettled([spyQuoteRequest, fxQuoteRequest]);

  const [spyResult, fxResult] = requests;
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
  const dividendsTotal = dividends.reduce((total, dividend) => total + dividend.amount, 0);
  const totalProfit = profit + dividendsTotal;
  const returnPercent = invested && (currentPrice || dividendsTotal) ? (totalProfit / invested) * 100 : 0;
  const investedIls = state.buys.reduce((total, buy) => {
    const purchaseRate = Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0 ? buy.purchaseExchangeRate : exchangeRate;
    return total + buy.shares * buy.price * purchaseRate;
  }, 0);
  const currentValueIls = currentPrice ? shares * currentPrice * exchangeRate : 0;
  const profitIls = currentValueIls - investedIls;
  const fxAdjustment = state.buys.reduce((total, buy) => {
    const purchaseRate = Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0 ? buy.purchaseExchangeRate : exchangeRate;
    return total + buy.shares * buy.price * Math.max(exchangeRate - purchaseRate, 0);
  }, 0);
  const taxableRealGainIls = Math.max(0, profitIls - fxAdjustment);
  const estimatedTaxIls = taxableRealGainIls * 0.25;
  const netProfitIls = profitIls - estimatedTaxIls + dividendsTotal * exchangeRate;

  document.querySelector('#return-percent').textContent = `${returnPercent.toFixed(2)}%`;
  document.querySelector('#return-percent').classList.toggle('negative', returnPercent < 0);
  document.querySelector('#profit-usd').textContent = signedMoney(totalProfit);
  document.querySelector('#profit-usd').classList.toggle('negative', totalProfit < 0);
  document.querySelector('#profit-ils').textContent = signedMoney(profitIls + dividendsTotal * exchangeRate, 'ILS');
  document.querySelector('#profit-ils').classList.toggle('negative', profitIls + dividendsTotal * exchangeRate < 0);
  document.querySelector('#net-profit-ils').textContent = signedMoney(netProfitIls, 'ILS');
  document.querySelector('#net-profit-ils').classList.toggle('negative', netProfitIls < 0);
  document.querySelector('#average-price').textContent = money(shares ? invested / shares : 0);
  document.querySelector('#shares-caption').textContent = `Across ${shares.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${shares === 1 ? 'share' : 'shares'}`;
  document.querySelector('#invested-value').textContent = money(invested);
  document.querySelector('#current-value').textContent = money(currentValue);
  document.querySelector('#dividend-total').textContent = money(dividendsTotal);
  document.querySelector('#lot-count').textContent = state.buys.length.toString();
  document.querySelector('#heading-count').textContent = `(${state.buys.length})`;
  document.querySelector('#dividend-count').textContent = `(${dividends.length})`;

  elements.list.replaceChildren();
  for (const buy of [...state.buys].sort((first, second) => (second.date || '').localeCompare(first.date || ''))) {
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
    remove.disabled = !stateWritable;
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
  document.querySelector('#return-caption').textContent = currentPrice ? 'Includes logged dividend payouts' : 'Enter a SPY price to see your return';

  elements.dividendList.replaceChildren();
  for (const dividend of [...dividends].sort((first, second) => second.date.localeCompare(first.date))) {
    const row = document.createElement('tr');
    const dateCell = document.createElement('td');
    dateCell.className = 'date-cell';
    dateCell.textContent = formatDate(dividend.date);
    const amountCell = document.createElement('td');
    amountCell.className = 'numeric';
    amountCell.textContent = money(dividend.amount);
    const reinvestedCell = document.createElement('td');
    reinvestedCell.textContent = dividend.reinvested ? 'Yes' : 'No';
    const actionCell = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.disabled = !dividendsWritable;
    remove.setAttribute('aria-label', `Remove dividend of ${money(dividend.amount)}`);
    remove.addEventListener('click', () => {
      dividends = dividends.filter((item) => item.id !== dividend.id);
      saveDividends();
      render();
    });
    actionCell.append(remove);
    row.append(dateCell, amountCell, reinvestedCell, actionCell);
    elements.dividendList.append(row);
  }
  const noDividends = dividends.length === 0;
  elements.dividendEmpty.classList.toggle('visible', noDividends);
  elements.dividendEmpty.hidden = !noDividends;
  elements.dividendList.hidden = noDividends;
  drawPriceChart();
}

function exportBackup() {
  const backup = {
    format: 'fieldnotes-spy-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    currentPrice: state.currentPrice,
    exchangeRate: state.exchangeRate,
    quoteUpdatedAt: state.quoteUpdatedAt,
    exchangeRateUpdatedAt: state.exchangeRateUpdatedAt,
    buys: state.buys,
    dividends,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `fieldnotes-spy-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isValidQuote(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function validateBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.format !== 'fieldnotes-spy-tracker' || data.version !== 1) {
    throw new Error('This is not a supported Fieldnotes SPY backup.');
  }
  if (!Array.isArray(data.buys) || !data.buys.every(isValidBuy)) throw new Error('The backup contains invalid buy lots.');
  const backupDividends = data.dividends === undefined ? [] : data.dividends;
  if (!Array.isArray(backupDividends) || !backupDividends.every(isValidDividend)) throw new Error('The backup contains invalid dividends.');
  const buyIds = data.buys.map((buy) => buy.id);
  const dividendIds = backupDividends.map((dividend) => dividend.id);
  if (new Set(buyIds).size !== buyIds.length || new Set(dividendIds).size !== dividendIds.length) throw new Error('The backup contains duplicate entry IDs.');
  if (!isValidQuote(data.currentPrice) || !isValidQuote(data.exchangeRate)) throw new Error('The backup contains an invalid market price or exchange rate.');
  for (const timestamp of [data.quoteUpdatedAt, data.exchangeRateUpdatedAt]) {
    if (timestamp !== undefined && timestamp !== null && !Number.isFinite(timestamp)) throw new Error('The backup contains an invalid quote timestamp.');
  }
  return {
    buys: data.buys,
    dividends: backupDividends,
    currentPrice: data.currentPrice ?? '',
    exchangeRate: data.exchangeRate ?? '',
    quoteUpdatedAt: Number.isFinite(data.quoteUpdatedAt) ? data.quoteUpdatedAt : null,
    exchangeRateUpdatedAt: Number.isFinite(data.exchangeRateUpdatedAt) ? data.exchangeRateUpdatedAt : null,
  };
}

function mergeById(existing, incoming) {
  const merged = [...existing];
  const ids = new Set(existing.map((item) => item.id));
  for (const item of incoming) {
    if (!ids.has(item.id)) {
      merged.push(item);
      ids.add(item.id);
    }
  }
  return merged;
}

function saveImportedBackup(nextState, nextDividends) {
  let previousDividends;
  try {
    previousDividends = localStorage.getItem(DIVIDEND_STORAGE_KEY);
    localStorage.setItem(DIVIDEND_STORAGE_KEY, JSON.stringify(nextDividends));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  } catch (error) {
    try {
      if (previousDividends === null) localStorage.removeItem(DIVIDEND_STORAGE_KEY);
      else if (previousDividends !== undefined) localStorage.setItem(DIVIDEND_STORAGE_KEY, previousDividends);
    } catch {
      dividendsWritable = false;
    }
    stateWritable = false;
    updateSaveStatus();
    window.alert(`The backup could not be saved. Existing data was preserved where possible. ${error.message}`);
    return false;
  }
  state = nextState;
  dividends = nextDividends;
  stateWritable = true;
  dividendsWritable = true;
  elements.currentPrice.value = state.currentPrice;
  elements.exchangeRate.value = state.exchangeRate;
  updateSaveStatus();
  render();
  return true;
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const backup = validateBackup(data);
    const replace = window.confirm('Replace all saved buys, dividends, and market values with this backup? Select Cancel to merge.');
    const merge = replace || window.confirm('Merge this backup with the saved buys and dividends? Existing market values will be kept.');
    if (!merge) return;
    const nextState = replace
      ? {
        buys: backup.buys,
        currentPrice: backup.currentPrice,
        exchangeRate: backup.exchangeRate,
        quoteUpdatedAt: backup.quoteUpdatedAt,
        exchangeRateUpdatedAt: backup.exchangeRateUpdatedAt,
      }
      : {
        ...state,
        buys: mergeById(state.buys, backup.buys),
        currentPrice: state.currentPrice || backup.currentPrice,
        exchangeRate: state.exchangeRate || backup.exchangeRate,
      };
    const nextDividends = replace ? backup.dividends : mergeById(dividends, backup.dividends);
    if (saveImportedBackup(nextState, nextDividends)) window.alert('Backup imported successfully.');
  } catch (error) {
    window.alert(`Could not import backup: ${error.message}`);
  } finally {
    elements.backupFile.value = '';
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const shares = numberFrom(elements.shares);
  const price = numberFrom(elements.buyPrice);
  if (!shares || !price) return;
  const purchaseExchangeRate = numberFrom(elements.buyExchangeRate) || numberFrom(elements.exchangeRate);
  const buy = {
    id: createId(),
    shares,
    price,
    date: elements.buyDate.value || new Date().toISOString().slice(0, 10),
  };
  if (purchaseExchangeRate) buy.purchaseExchangeRate = purchaseExchangeRate;
  state.buys.push(buy);
  saveState();
  elements.form.reset();
  render();
  elements.shares.focus();
});

elements.dividendForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = numberFrom(elements.dividendAmount);
  if (!amount || !isValidDate(elements.dividendDate.value)) return;
  dividends.push({
    id: createId(),
    date: elements.dividendDate.value,
    amount,
    reinvested: elements.dividendReinvested.checked,
  });
  saveDividends();
  elements.dividendForm.reset();
  render();
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
  if (!window.confirm('Remove all SPY buys? Logged dividends will remain saved. This cannot be undone.')) return;
  state.buys = [];
  saveState();
  render();
});

elements.exportBackup.addEventListener('click', exportBackup);
elements.importBackup.addEventListener('click', () => elements.backupFile.click());
elements.backupFile.addEventListener('change', () => {
  const [file] = elements.backupFile.files;
  if (file) importBackup(file);
});

elements.currentPrice.value = state.currentPrice;
elements.exchangeRate.value = state.exchangeRate;
updateSaveStatus();
if (!dividendsWritable) elements.dividendForm.querySelector('button[type="submit"]').disabled = true;
if (state.quoteUpdatedAt) showQuoteStatus(elements.spyQuoteStatus, `Saved SPY · ${quoteTime(state.quoteUpdatedAt)}`);
if (state.exchangeRateUpdatedAt) showQuoteStatus(elements.fxQuoteStatus, `Saved USD / ILS · ${fxQuoteTime(state.exchangeRateUpdatedAt)}`);
if (!hasLocalQuoteApi) {
  showQuoteStatus(elements.spyQuoteStatus, 'Fetching SPY quote…');
  showQuoteStatus(elements.fxQuoteStatus, 'Fetching USD / ILS rate…');
}
render();
refreshQuote();
window.setInterval(refreshQuote, hasLocalQuoteApi ? 5 * 60 * 1000 : 15 * 60 * 1000);