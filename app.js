const STORAGE_KEY = 'fieldnotes.spy-tracker.v1';
const DIVIDEND_STORAGE_KEY = 'fieldnotes.spy-tracker.dividends.v1';
const SYNC_OWNER_STORAGE_KEY = 'fieldnotes.spy-tracker.sync-owner.v1';
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
  toggleBuyList: document.querySelector('#toggle-buy-list'),
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
  chartTooltip: document.querySelector('#chart-tooltip'),
  returnDirection: document.querySelector('#return-direction'),
  toastRegion: document.querySelector('#toast-region'),
  signInButton: document.querySelector('#sign-in-button'),
  syncStatus: document.querySelector('#sync-status'),
  syncConflictDialog: document.querySelector('#sync-conflict-dialog'),
};

let firebaseAuth = null;
let firestore = null;
let currentUser = null;
let userDocument = null;
let unsubscribeCloud = null;
let cloudInitialResolved = false;
let cloudInitialResolution = null;
let cloudSyncTimer = null;
let syncPausedForConflict = false;
let cloudSyncInProgress = false;
let cloudWriteQueued = false;
let cloudWriteFingerprint = null;
let lastSyncedCloudFingerprint = null;
let cloudListenerGeneration = 0;
let pendingCloudSnapshot = null;
let accountSwitchApproved = false;

function setSyncStatus(message, stateName = 'idle', title = '') {
  elements.syncStatus.textContent = message;
  elements.syncStatus.dataset.state = stateName;
  elements.syncStatus.title = title;
}

function firebaseConfigIsReady() {
  const config = window.FIELDNOTES_FIREBASE_CONFIG;
  return Boolean(config && ['apiKey', 'authDomain', 'projectId', 'appId'].every((key) => (
    typeof config[key] === 'string' && config[key].trim() && !config[key].startsWith('PASTE_')
  )));
}

function rememberSyncOwner(uid) {
  try {
    localStorage.setItem(SYNC_OWNER_STORAGE_KEY, uid);
    return true;
  } catch (error) {
    setSyncStatus('Sync warning: account could not be remembered', 'error', error.message);
    return false;
  }
}

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
      updatedAt: Number.isFinite(saved?.updatedAt) ? saved.updatedAt : 0,
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
let showAllBuys = false;

function saveState() {
  if (!stateWritable) return false;
  try {
    state.updatedAt = nextUpdatedAt(state.updatedAt);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    scheduleCloudWrite();
    return true;
  } catch {
    stateWritable = false;
    updateSaveStatus();
    return false;
  }
}

function saveDividends() {
  if (!dividendsWritable) return false;
  state.updatedAt = nextUpdatedAt(state.updatedAt);
  return persistLocalTrackerData(currentTrackerData(), { sync: true });
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

function timestampValue(value) {
  if (Number.isFinite(value)) return value;
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return 0;
}

function nextUpdatedAt(previous = 0) {
  return Math.max(Date.now(), (Number.isFinite(previous) ? previous : 0) + 1);
}

function currentTrackerData() {
  const recordUpdatedAt = Number.isFinite(state.updatedAt) && state.updatedAt > 0 ? state.updatedAt : 1;
  return {
    buys: state.buys.map((buy) => Number.isFinite(buy.updatedAt) ? buy : { ...buy, updatedAt: recordUpdatedAt }),
    dividends: dividends.map((dividend) => Number.isFinite(dividend.updatedAt) ? dividend : { ...dividend, updatedAt: recordUpdatedAt }),
    currentPrice: state.currentPrice,
    exchangeRate: state.exchangeRate,
    quoteUpdatedAt: state.quoteUpdatedAt,
    exchangeRateUpdatedAt: state.exchangeRateUpdatedAt,
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : 0,
  };
}

function normalizeCloudData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The cloud tracker document is not a valid object.');
  const rawBuys = data.buys === undefined ? [] : data.buys;
  const rawDividends = data.dividends === undefined ? [] : data.dividends;
  if (!Array.isArray(rawBuys) || !rawBuys.every(isValidBuy)) throw new Error('The cloud tracker contains invalid buy lots.');
  if (!Array.isArray(rawDividends) || !rawDividends.every(isValidDividend)) throw new Error('The cloud tracker contains invalid dividends.');
  if (!isValidQuote(data.currentPrice) || !isValidQuote(data.exchangeRate)) throw new Error('The cloud tracker contains invalid market settings.');
  const updatedAt = timestampValue(data.updatedAt) || timestampValue(data.clientUpdatedAt);
  const recordUpdatedAt = updatedAt || 1;
  return {
    buys: rawBuys.map((buy) => Number.isFinite(buy.updatedAt) ? buy : { ...buy, updatedAt: recordUpdatedAt }),
    dividends: rawDividends.map((dividend) => Number.isFinite(dividend.updatedAt) ? dividend : { ...dividend, updatedAt: recordUpdatedAt }),
    currentPrice: data.currentPrice ?? '',
    exchangeRate: data.exchangeRate ?? '',
    quoteUpdatedAt: Number.isFinite(data.quoteUpdatedAt) ? data.quoteUpdatedAt : null,
    exchangeRateUpdatedAt: Number.isFinite(data.exchangeRateUpdatedAt) ? data.exchangeRateUpdatedAt : null,
    updatedAt,
  };
}

function trackerDataHasRecords(data) {
  return data.buys.length > 0 || data.dividends.length > 0;
}

function trackerDataHasContent(data) {
  return trackerDataHasRecords(data) || Boolean(data.currentPrice || data.exchangeRate);
}

function localNeedsRecordMetadata() {
  return state.buys.some((buy) => !Number.isFinite(buy.updatedAt))
    || dividends.some((dividend) => !Number.isFinite(dividend.updatedAt));
}

function buySignature(buy) {
  return `${buy.date}|${Number(buy.shares)}|${Number(buy.price)}`;
}

function mergeRecordLists(first, second, kind) {
  const records = new Map();
  for (const item of [...first, ...second]) {
    const previous = records.get(item.id);
    const itemTime = Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
    const previousTime = Number.isFinite(previous?.updatedAt) ? previous.updatedAt : 0;
    if (!previous || itemTime > previousTime || (itemTime === previousTime && item.deleted && !previous.deleted)) {
      records.set(item.id, item);
    }
  }

  if (kind === 'buy') {
    const activeBySignature = new Map();
    for (const item of records.values()) {
      if (item.deleted) continue;
      const signature = buySignature(item);
      const previous = activeBySignature.get(signature);
      const itemTime = Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
      const previousTime = Number.isFinite(previous?.updatedAt) ? previous.updatedAt : 0;
      if (!previous || itemTime > previousTime || (itemTime === previousTime && item.id.localeCompare(previous.id) < 0)) {
        activeBySignature.set(signature, item);
      }
    }
    for (const item of records.values()) {
      if (item.deleted || activeBySignature.get(buySignature(item)) === item) continue;
      records.set(item.id, { ...item, deleted: true, updatedAt: nextUpdatedAt(item.updatedAt) });
    }
  }
  return [...records.values()];
}

function chooseRecords(preferred, other, kind) {
  const records = new Map(preferred.map((item) => [item.id, item]));
  for (const item of other) {
    if (!item.deleted) continue;
    const previous = records.get(item.id);
    const itemTime = Number.isFinite(item.updatedAt) ? item.updatedAt : 0;
    const previousTime = Number.isFinite(previous?.updatedAt) ? previous.updatedAt : 0;
    if (!previous || itemTime >= previousTime) records.set(item.id, item);
  }
  return kind === 'buy' ? mergeRecordLists([...records.values()], [], kind) : [...records.values()];
}

function mergeTrackerData(local, remote, preference = 'newest') {
  const settings = preference === 'cloud'
    ? remote
    : preference === 'device'
      ? local
      : (local.updatedAt >= remote.updatedAt ? local : remote);
  let buys;
  let mergedDividends;
  if (preference === 'cloud') {
    buys = chooseRecords(remote.buys, local.buys, 'buy');
    mergedDividends = chooseRecords(remote.dividends, local.dividends, 'dividend');
  } else if (preference === 'device') {
    buys = chooseRecords(local.buys, remote.buys, 'buy');
    mergedDividends = chooseRecords(local.dividends, remote.dividends, 'dividend');
  } else {
    buys = mergeRecordLists(local.buys, remote.buys, 'buy');
    mergedDividends = mergeRecordLists(local.dividends, remote.dividends, 'dividend');
  }
  return {
    ...settings,
    buys,
    dividends: mergedDividends,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
  };
}

function stableTrackerData(data) {
  const sortObjectKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortObjectKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
    }
    return value;
  };
  return JSON.stringify(sortObjectKeys({
    currentPrice: data.currentPrice,
    exchangeRate: data.exchangeRate,
    quoteUpdatedAt: data.quoteUpdatedAt,
    exchangeRateUpdatedAt: data.exchangeRateUpdatedAt,
    buys: [...data.buys].sort((first, second) => first.id.localeCompare(second.id)),
    dividends: [...data.dividends].sort((first, second) => first.id.localeCompare(second.id)),
  }));
}

function persistLocalTrackerData(data, options = {}) {
  if (!stateWritable || !dividendsWritable) {
    setSyncStatus('Sync blocked by local storage error', 'error');
    return false;
  }
  const shouldRender = stableTrackerData(data) !== stableTrackerData(currentTrackerData());
  let previousState;
  let previousDividends;
  try {
    previousState = localStorage.getItem(STORAGE_KEY);
    previousDividends = localStorage.getItem(DIVIDEND_STORAGE_KEY);
    const nextState = {
      buys: data.buys,
      currentPrice: data.currentPrice,
      exchangeRate: data.exchangeRate,
      quoteUpdatedAt: data.quoteUpdatedAt,
      exchangeRateUpdatedAt: data.exchangeRateUpdatedAt,
      updatedAt: data.updatedAt,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    localStorage.setItem(DIVIDEND_STORAGE_KEY, JSON.stringify(data.dividends));
  } catch (error) {
    try {
      if (previousState === null) localStorage.removeItem(STORAGE_KEY);
      else if (previousState !== undefined) localStorage.setItem(STORAGE_KEY, previousState);
      if (previousDividends === null) localStorage.removeItem(DIVIDEND_STORAGE_KEY);
      else if (previousDividends !== undefined) localStorage.setItem(DIVIDEND_STORAGE_KEY, previousDividends);
    } catch {
      stateWritable = false;
      dividendsWritable = false;
    }
    stateWritable = false;
    dividendsWritable = false;
    updateSaveStatus();
    if (options.sync === false) setSyncStatus(`Sync blocked: ${error.message}`, 'error');
    return false;
  }

  state = {
    buys: data.buys,
    currentPrice: data.currentPrice,
    exchangeRate: data.exchangeRate,
    quoteUpdatedAt: data.quoteUpdatedAt,
    exchangeRateUpdatedAt: data.exchangeRateUpdatedAt,
    updatedAt: data.updatedAt,
  };
  dividends = data.dividends;
  elements.currentPrice.value = state.currentPrice;
  elements.exchangeRate.value = state.exchangeRate;
  updateSaveStatus();
  if (shouldRender) {
    const scrollLeft = window.scrollX;
    const scrollTop = window.scrollY;
    render();
    window.scrollTo(scrollLeft, scrollTop);
  }
  if (options.sync !== false) scheduleCloudWrite();
  return true;
}

function scheduleCloudWrite(delay = 1000) {
  if (!currentUser || !userDocument || !cloudInitialResolved || syncPausedForConflict || accountSwitchApproved) return;
  const data = currentTrackerData();
  const fingerprint = stableTrackerData(data);
  if (fingerprint === lastSyncedCloudFingerprint) {
    setSyncStatus('Synced ✓', 'synced');
    return;
  }
  if (cloudSyncInProgress && fingerprint === cloudWriteFingerprint) return;
  if (cloudSyncInProgress) {
    cloudWriteQueued = true;
    return;
  }
  if (cloudSyncTimer !== null) window.clearTimeout(cloudSyncTimer);
  setSyncStatus(navigator.onLine ? 'Syncing…' : 'Offline', navigator.onLine ? 'syncing' : 'offline');
  if (!navigator.onLine) {
    cloudWriteQueued = true;
    return;
  }
  cloudSyncTimer = window.setTimeout(() => {
    cloudSyncTimer = null;
    void writeCloudData(currentTrackerData());
  }, delay);
}

async function writeCloudData(data) {
  if (!currentUser || !userDocument || !cloudInitialResolved || syncPausedForConflict || accountSwitchApproved) return false;
  const fingerprint = stableTrackerData(data);
  if (fingerprint === lastSyncedCloudFingerprint) return true;
  if (!stateWritable || !dividendsWritable) {
    setSyncStatus('Sync blocked by local storage error', 'error');
    return false;
  }
  if (!navigator.onLine) {
    cloudWriteQueued = true;
    setSyncStatus('Offline', 'offline');
    return false;
  }
  if (cloudSyncInProgress) {
    cloudWriteQueued = true;
    return false;
  }
  const generation = cloudListenerGeneration;
  const targetDocument = userDocument;
  cloudSyncInProgress = true;
  cloudWriteFingerprint = fingerprint;
  cloudWriteQueued = false;
  setSyncStatus('Syncing…', 'syncing');
  try {
    await targetDocument.set({
      ...data,
      clientUpdatedAt: data.updatedAt,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if (generation === cloudListenerGeneration) {
      lastSyncedCloudFingerprint = fingerprint;
      if (rememberSyncOwner(currentUser.uid)) setSyncStatus('Synced ✓', 'synced');
    }
    return true;
  } catch (error) {
    if (generation === cloudListenerGeneration) {
      setSyncStatus(navigator.onLine ? `Sync error: ${error.message}` : 'Offline', navigator.onLine ? 'error' : 'offline', error.message);
    }
    return false;
  } finally {
    if (generation === cloudListenerGeneration) {
      cloudSyncInProgress = false;
      cloudWriteFingerprint = null;
      if (cloudWriteQueued && navigator.onLine) scheduleCloudWrite(0);
    }
  }
}

function requestSyncChoice() {
  return new Promise((resolve) => {
    const dialog = elements.syncConflictDialog;
    const handleClose = () => resolve(dialog.returnValue || 'cancel');
    dialog.addEventListener('close', handleClose, { once: true });
    dialog.showModal();
  });
}

async function resolveInitialCloudData(snapshot, generation) {
  let remote = snapshot.exists ? normalizeCloudData(snapshot.data()) : {
    buys: [],
    dividends: [],
    currentPrice: '',
    exchangeRate: '',
    quoteUpdatedAt: null,
    exchangeRateUpdatedAt: null,
    updatedAt: 0,
  };
  lastSyncedCloudFingerprint = stableTrackerData(remote);
  const local = currentTrackerData();
  const localHasRecords = trackerDataHasRecords(local);
  const remoteHasRecords = trackerDataHasRecords(remote);

  if (accountSwitchApproved) {
    cloudInitialResolved = true;
    if (persistLocalTrackerData(remote, { sync: false })) {
      accountSwitchApproved = false;
      if (rememberSyncOwner(currentUser.uid)) setSyncStatus('Synced ✓', 'synced');
    }
    return;
  }

  if (localHasRecords && remoteHasRecords) {
    const choice = await requestSyncChoice();
    if (generation !== cloudListenerGeneration) return;
    if (choice === 'cancel') {
      syncPausedForConflict = true;
      setSyncStatus('Sync paused', 'error', 'Sign out and back in to choose a sync option.');
      return;
    }
    if (pendingCloudSnapshot) {
      const latest = pendingCloudSnapshot;
      pendingCloudSnapshot = null;
      remote = latest.exists ? normalizeCloudData(latest.data()) : {
        buys: [],
        dividends: [],
        currentPrice: '',
        exchangeRate: '',
        quoteUpdatedAt: null,
        exchangeRateUpdatedAt: null,
        updatedAt: 0,
      };
      lastSyncedCloudFingerprint = stableTrackerData(remote);
    }
    const merged = mergeTrackerData(currentTrackerData(), remote, choice);
    cloudInitialResolved = true;
    if (persistLocalTrackerData(merged, { sync: false })) {
      if (choice !== 'cloud' || stableTrackerData(merged) !== stableTrackerData(remote)) {
        await writeCloudData(currentTrackerData());
      } else {
        if (rememberSyncOwner(currentUser.uid)) setSyncStatus('Synced ✓', 'synced');
      }
    }
    return;
  }

  const merged = mergeTrackerData(local, remote);
  cloudInitialResolved = true;
  if (!snapshot.exists && trackerDataHasContent(local)) {
    if (!persistLocalTrackerData(local, { sync: false })) return;
    await writeCloudData(local);
    return;
  }
  if (stableTrackerData(merged) !== stableTrackerData(local)
    || merged.updatedAt > local.updatedAt
    || localNeedsRecordMetadata()) {
    if (!persistLocalTrackerData(merged, { sync: false })) return;
  }
  if (stableTrackerData(merged) !== stableTrackerData(remote)) {
    await writeCloudData(currentTrackerData());
  } else {
    if (rememberSyncOwner(currentUser.uid)) setSyncStatus('Synced ✓', 'synced');
  }
}

function handleCloudSnapshot(snapshot, generation = cloudListenerGeneration) {
  if (generation !== cloudListenerGeneration || !currentUser || syncPausedForConflict) return;
  if (!cloudInitialResolved) {
    if (snapshot.metadata?.fromCache) {
      setSyncStatus(navigator.onLine ? 'Syncing…' : 'Offline', navigator.onLine ? 'syncing' : 'offline');
      return;
    }
    if (cloudInitialResolution) {
      pendingCloudSnapshot = snapshot;
      return;
    }
    cloudInitialResolution = resolveInitialCloudData(snapshot, generation)
      .catch((error) => {
        if (generation === cloudListenerGeneration) setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
      })
      .finally(() => {
        if (generation !== cloudListenerGeneration) return;
        cloudInitialResolution = null;
        const pending = pendingCloudSnapshot;
        pendingCloudSnapshot = null;
        if (pending && cloudInitialResolved) handleCloudSnapshot(pending, generation);
      });
    return;
  }
  if (snapshot.metadata?.hasPendingWrites) return;
  if (!snapshot.exists) {
    setSyncStatus('Cloud data unavailable', 'error', 'The signed-in tracker document was removed.');
    return;
  }
  try {
    const remote = normalizeCloudData(snapshot.data());
    lastSyncedCloudFingerprint = stableTrackerData(remote);
    const local = currentTrackerData();
    const merged = mergeTrackerData(local, remote);
    const localChanged = stableTrackerData(merged) !== stableTrackerData(local);
    const localTimestampBehind = merged.updatedAt > local.updatedAt;
    const cloudChanged = stableTrackerData(merged) !== stableTrackerData(remote);
    if ((localChanged || localTimestampBehind || localNeedsRecordMetadata())
      && !persistLocalTrackerData(merged, { sync: false })) return;
    if (cloudChanged) {
      scheduleCloudWrite();
    } else {
      setSyncStatus('Synced ✓', 'synced');
    }
  } catch (error) {
    setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
  }
}

function connectCloudListener() {
  if (!currentUser || !firestore || userDocument) return;
  const generation = cloudListenerGeneration;
  userDocument = firestore.doc(`users/${currentUser.uid}/tracker/data`);
  unsubscribeCloud = userDocument.onSnapshot(
    (snapshot) => handleCloudSnapshot(snapshot, generation),
    (error) => {
      if (generation === cloudListenerGeneration) setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
    },
  );
}

function handleAuthStateChange(user) {
  cloudListenerGeneration += 1;
  if (unsubscribeCloud) unsubscribeCloud();
  if (cloudSyncTimer !== null) window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = null;
  currentUser = user;
  userDocument = null;
  cloudInitialResolved = false;
  cloudInitialResolution = null;
  syncPausedForConflict = false;
  cloudWriteQueued = false;
  cloudSyncInProgress = false;
  cloudWriteFingerprint = null;
  lastSyncedCloudFingerprint = null;
  pendingCloudSnapshot = null;
  accountSwitchApproved = false;
  elements.signInButton.textContent = user ? 'Sign out' : 'Sign in with Google';
  if (!user) {
    setSyncStatus(firebaseConfigIsReady() ? 'Not signed in' : 'Sync setup needed', 'idle');
    return;
  }
  try {
    const previousOwner = localStorage.getItem(SYNC_OWNER_STORAGE_KEY);
    if (previousOwner && previousOwner !== user.uid) {
      const useCloud = window.confirm(
        'This browser has tracker data previously synced to a different Google account. Continuing will replace this browser’s local data with the selected account’s cloud data. Export a backup first if you need the current local data. Continue?',
      );
      if (!useCloud) {
        syncPausedForConflict = true;
        setSyncStatus('Sync paused', 'error', 'Sign out to keep using the current local data.');
        return;
      }
      accountSwitchApproved = true;
    }
  } catch (error) {
    syncPausedForConflict = true;
    setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus('Offline', 'offline');
    return;
  }
  setSyncStatus('Syncing…', 'syncing');
  connectCloudListener();
}

function initializeCloudSync() {
  if (!firebaseConfigIsReady()) {
    setSyncStatus('Sync setup needed', 'idle', 'Paste the Firebase web config into firebase-config.js.');
    return;
  }
  if (typeof firebase === 'undefined') {
    setSyncStatus('Sync SDK unavailable', 'error', 'The Firebase SDK could not be loaded from the official CDN.');
    return;
  }
  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.FIELDNOTES_FIREBASE_CONFIG);
    firebaseAuth = app.auth();
    firestore = app.firestore();
    firebaseAuth.onAuthStateChanged(handleAuthStateChange, (error) => {
      setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
    });
    firebaseAuth.getRedirectResult().catch((error) => {
      setSyncStatus(`Sign-in error: ${error.message}`, 'error', error.message);
    });
  } catch (error) {
    setSyncStatus(`Sync error: ${error.message}`, 'error', error.message);
  }
}

async function toggleGoogleSignIn() {
  if (!firebaseConfigIsReady()) {
    setSyncStatus('Sync setup needed', 'idle', 'Paste the Firebase web config into firebase-config.js.');
    window.alert('Add your Firebase web app config to firebase-config.js before signing in.');
    return;
  }
  if (!firebaseAuth) {
    window.alert('Firebase could not initialize. Check your Firebase config and network connection.');
    return;
  }
  elements.signInButton.disabled = true;
  try {
    if (firebaseAuth.currentUser) {
      await firebaseAuth.signOut();
    } else {
      const provider = new firebase.auth.GoogleAuthProvider();
      if (window.matchMedia('(max-width: 760px)').matches) {
        await firebaseAuth.signInWithRedirect(provider);
      } else {
        await firebaseAuth.signInWithPopup(provider);
      }
    }
  } catch (error) {
    setSyncStatus(`Sign-in error: ${error.message}`, 'error', error.message);
  } finally {
    elements.signInButton.disabled = false;
  }
}

window.addEventListener('offline', () => {
  if (currentUser) setSyncStatus('Offline', 'offline');
});
window.addEventListener('online', () => {
  if (!currentUser) return;
  if (!userDocument) connectCloudListener();
  else if (cloudInitialResolved) scheduleCloudWrite(0);
});

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
    && (buy.purchaseExchangeRate === undefined || (Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0))
    && (buy.updatedAt === undefined || (Number.isFinite(buy.updatedAt) && buy.updatedAt >= 0))
    && (buy.deleted === undefined || typeof buy.deleted === 'boolean'),
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
    && (dividend.reinvested === undefined || typeof dividend.reinvested === 'boolean')
    && (dividend.updatedAt === undefined || (Number.isFinite(dividend.updatedAt) && dividend.updatedAt >= 0))
    && (dividend.deleted === undefined || typeof dividend.deleted === 'boolean'),
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
  const buys = state.buys.filter((buy) => !buy.deleted).sort((first, second) => (first.date || '').localeCompare(second.date || ''));
  svg.replaceChildren(svg.querySelector('desc'));
  elements.chartTooltip.hidden = true;
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
    const pillY = Math.max(plot.top + 2, Math.min(y - 27, plot.bottom - 24));
    svg.append(svgElement('rect', {
      x: plot.left + 8,
      y: pillY,
      width: 132,
      height: 21,
      rx: 5,
      class: 'chart-market-pill',
    }));
    const label = svgElement('text', { x: plot.left + 16, y: pillY + 15, class: 'chart-market-label' });
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
  for (const point of averagePoints) svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: 3, class: 'chart-average-point' }));

  const activeDotLayer = svgElement('g', { 'aria-hidden': 'true' });
  for (let index = 0; index < buys.length; index += 1) {
    const buy = buys[index];
    const x = xFor(index);
    const y = yFor(buy.price);
    const buyValue = buy.shares * buy.price;
    const lotReturn = currentPrice && buyValue ? ((buy.shares * currentPrice - buyValue) / buyValue) * 100 : null;
    const returnText = lotReturn === null ? '—' : `${lotReturn > 0 ? '+' : ''}${lotReturn.toFixed(2)}%`;
    const details = `${formatDate(buy.date)} · ${buy.shares.toLocaleString('en-US', { maximumFractionDigits: 6 })} shares\nBuy price ${money(buy.price)} · Return ${returnText}`;
    const mark = svgElement('g', {
      class: 'chart-purchase-mark',
      tabindex: '0',
      role: 'img',
      'aria-label': details.replace('\n', '. '),
      'aria-describedby': 'chart-tooltip',
    });
    const hit = svgElement('circle', { cx: x, cy: y, r: 24, class: 'chart-purchase-hit' });
    const dot = svgElement('circle', { cx: x, cy: y, r: 4, class: 'chart-purchase-point' });
    const title = svgElement('title');
    title.textContent = details.replace('\n', ' · ');
    mark.append(hit, dot, title);

    const showTooltip = () => {
      elements.chartTooltip.textContent = details;
      elements.chartTooltip.hidden = false;
      mark.classList.add('is-active');
      activeDotLayer.replaceChildren(svgElement('circle', { cx: x, cy: y, r: 8, class: 'chart-purchase-active' }));
      const point = svg.createSVGPoint();
      point.x = x;
      point.y = y;
      const transform = svg.getScreenCTM();
      if (!transform) return;
      const screenPoint = point.matrixTransform(transform);
      const cardRect = svg.parentElement.getBoundingClientRect();
      const tooltipRect = elements.chartTooltip.getBoundingClientRect();
      const left = Math.max(8, Math.min(
        screenPoint.x - cardRect.left - tooltipRect.width / 2,
        cardRect.width - tooltipRect.width - 8,
      ));
      const above = screenPoint.y - cardRect.top - tooltipRect.height - 12;
      const top = above >= 8 ? above : Math.min(cardRect.height - tooltipRect.height - 8, screenPoint.y - cardRect.top + 12);
      elements.chartTooltip.style.left = `${left}px`;
      elements.chartTooltip.style.top = `${Math.max(8, top)}px`;
    };
    const hideTooltip = () => {
      mark.classList.remove('is-active');
      activeDotLayer.replaceChildren();
      elements.chartTooltip.hidden = true;
    };
    mark.addEventListener('pointerenter', showTooltip);
    mark.addEventListener('pointerleave', () => {
      if (!mark.matches(':focus')) hideTooltip();
    });
    mark.addEventListener('focus', showTooltip);
    mark.addEventListener('blur', hideTooltip);
    svg.append(mark);
  }
  svg.append(activeDotLayer);

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

function showUndoToast(kind, message, undo) {
  const toast = document.createElement('div');
  toast.className = 'undo-toast';
  toast.dataset.kind = kind;
  toast.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = message;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Undo';
  const timeout = window.setTimeout(() => toast.remove(), 6000);
  button.addEventListener('click', () => {
    window.clearTimeout(timeout);
    toast.remove();
    undo();
  });
  toast.append(label, button);
  elements.toastRegion.append(toast);
}

function dismissUndoToasts(kind) {
  const selector = kind ? `[data-kind="${kind}"]` : '.undo-toast';
  for (const toast of elements.toastRegion.querySelectorAll(selector)) toast.remove();
}

function render() {
  const currentPrice = numberFrom(elements.currentPrice);
  const exchangeRate = numberFrom(elements.exchangeRate);
  const activeBuys = state.buys.filter((buy) => !buy.deleted);
  const activeDividends = dividends.filter((dividend) => !dividend.deleted);
  const shares = activeBuys.reduce((total, buy) => total + buy.shares, 0);
  const invested = activeBuys.reduce((total, buy) => total + buy.shares * buy.price, 0);
  const currentValue = currentPrice ? shares * currentPrice : 0;
  const profit = currentPrice ? currentValue - invested : 0;
  const dividendsTotal = activeDividends.reduce((total, dividend) => total + dividend.amount, 0);
  const totalProfit = profit + dividendsTotal;
  const returnPercent = invested && (currentPrice || dividendsTotal) ? (totalProfit / invested) * 100 : 0;
  const investedIls = activeBuys.reduce((total, buy) => {
    const purchaseRate = Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0 ? buy.purchaseExchangeRate : exchangeRate;
    return total + buy.shares * buy.price * purchaseRate;
  }, 0);
  const currentValueIls = currentPrice ? shares * currentPrice * exchangeRate : 0;
  const profitIls = currentValueIls - investedIls;
  const fxAdjustment = activeBuys.reduce((total, buy) => {
    const purchaseRate = Number.isFinite(buy.purchaseExchangeRate) && buy.purchaseExchangeRate > 0 ? buy.purchaseExchangeRate : exchangeRate;
    return total + buy.shares * buy.price * Math.max(exchangeRate - purchaseRate, 0);
  }, 0);
  const taxableRealGainIls = Math.max(0, profitIls - fxAdjustment);
  const estimatedTaxIls = taxableRealGainIls * 0.25;
  const netProfitIls = profitIls - estimatedTaxIls + dividendsTotal * exchangeRate;

  document.querySelector('#return-percent').textContent = `${returnPercent.toFixed(2)}%`;
  document.querySelector('#return-percent').classList.toggle('negative', returnPercent < 0);
  elements.returnDirection.textContent = returnPercent < 0 ? '▼' : '▲';
  elements.returnDirection.classList.toggle('negative', returnPercent < 0);
  elements.returnDirection.title = returnPercent < 0 ? 'Negative total return' : 'Positive total return';
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
  document.querySelector('#lot-count').textContent = activeBuys.length.toString();
  document.querySelector('#heading-count').textContent = `(${activeBuys.length})`;
  document.querySelector('#dividend-count').textContent = `(${activeDividends.length})`;

  elements.list.replaceChildren();
  const sortedBuys = [...activeBuys].sort((first, second) => (second.date || '').localeCompare(first.date || ''));
  if (activeBuys.length <= 8) showAllBuys = false;
  const visibleBuys = showAllBuys ? sortedBuys : sortedBuys.slice(0, 8);
  for (const buy of visibleBuys) {
    const row = document.createElement('tr');
    const buyValue = buy.shares * buy.price;
    const lotValue = currentPrice ? buy.shares * currentPrice : 0;
    const lotProfit = currentPrice ? lotValue - buyValue : 0;
    const lotReturn = buyValue && currentPrice ? (lotProfit / buyValue) * 100 : 0;
    const cells = [
      { text: formatDate(buy.date), className: 'date-cell' },
      { text: buy.shares.toFixed(4), className: 'numeric' },
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
      state.buys = state.buys.map((item) => item.id === buy.id
        ? { ...item, deleted: true, updatedAt: nextUpdatedAt(item.updatedAt) }
        : item);
      saveState();
      render();
      showUndoToast('buy', 'Buy lot deleted.', () => {
        state.buys = state.buys.map((item) => item.id === buy.id
          ? { ...item, deleted: false, updatedAt: nextUpdatedAt(item.updatedAt) }
          : item);
        saveState();
        render();
      });
    });
    actionCell.append(remove);
    row.append(actionCell);
    elements.list.append(row);
  }

  const isEmpty = activeBuys.length === 0;
  elements.emptyState.classList.toggle('visible', isEmpty);
  elements.list.hidden = isEmpty;
  elements.clearAll.hidden = isEmpty;
  elements.toggleBuyList.hidden = activeBuys.length <= 8;
  elements.toggleBuyList.textContent = showAllBuys ? 'Show less' : `Show all (${activeBuys.length})`;
  document.querySelector('#return-caption').textContent = currentPrice ? 'Includes logged dividend payouts' : 'Enter a SPY price to see your return';

  elements.dividendList.replaceChildren();
  for (const dividend of [...activeDividends].sort((first, second) => second.date.localeCompare(first.date))) {
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
      dividends = dividends.map((item) => item.id === dividend.id
        ? { ...item, deleted: true, updatedAt: nextUpdatedAt(item.updatedAt) }
        : item);
      saveDividends();
      render();
      showUndoToast('dividend', 'Dividend deleted.', () => {
        dividends = dividends.map((item) => item.id === dividend.id
          ? { ...item, deleted: false, updatedAt: nextUpdatedAt(item.updatedAt) }
          : item);
        saveDividends();
        render();
      });
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
    buys: state.buys.filter((buy) => !buy.deleted),
    dividends: dividends.filter((dividend) => !dividend.deleted),
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
  stateWritable = true;
  dividendsWritable = true;
  const nextData = {
    ...nextState,
    buys: nextState.buys.map((buy) => ({ ...buy, updatedAt: Number.isFinite(buy.updatedAt) ? buy.updatedAt : nextUpdatedAt() })),
    dividends: nextDividends.map((dividend) => ({ ...dividend, updatedAt: Number.isFinite(dividend.updatedAt) ? dividend.updatedAt : nextUpdatedAt() })),
    updatedAt: nextUpdatedAt(nextState.updatedAt),
  };
  if (persistLocalTrackerData(nextData, { sync: true })) return true;
  window.alert('The backup could not be saved. Existing data was preserved where possible.');
  return false;
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const backup = validateBackup(data);
    const replace = window.confirm('Replace all saved buys, dividends, and market values with this backup? Select Cancel to merge.');
    const merge = replace || window.confirm('Merge this backup with the saved buys and dividends? Existing market values will be kept.');
    if (!merge) return;
    const now = nextUpdatedAt(state.updatedAt);
    const importedBuys = backup.buys.map((buy) => ({ ...buy, updatedAt: now }));
    const importedDividends = backup.dividends.map((dividend) => ({
      ...dividend,
      updatedAt: now,
    }));
    const replacementBuys = replace
      ? [
        ...importedBuys,
        ...state.buys.filter((buy) => buy.deleted && !importedBuys.some((incoming) => incoming.id === buy.id)),
        ...state.buys.filter((buy) => !buy.deleted && !backup.buys.some((incoming) => incoming.id === buy.id))
          .map((buy) => ({ ...buy, deleted: true, updatedAt: now })),
      ]
      : mergeById(state.buys, importedBuys);
    const replacementDividends = replace
      ? [
        ...importedDividends,
        ...dividends.filter((dividend) => dividend.deleted && !importedDividends.some((incoming) => incoming.id === dividend.id)),
        ...dividends.filter((dividend) => !dividend.deleted && !backup.dividends.some((incoming) => incoming.id === dividend.id))
          .map((dividend) => ({ ...dividend, deleted: true, updatedAt: now })),
      ]
      : mergeById(dividends, importedDividends);
    const nextState = replace
      ? {
        buys: replacementBuys,
        currentPrice: backup.currentPrice,
        exchangeRate: backup.exchangeRate,
        quoteUpdatedAt: backup.quoteUpdatedAt,
        exchangeRateUpdatedAt: backup.exchangeRateUpdatedAt,
      }
      : {
        ...state,
        buys: replacementBuys,
        currentPrice: state.currentPrice || backup.currentPrice,
        exchangeRate: state.exchangeRate || backup.exchangeRate,
      };
    const nextDividends = replacementDividends;
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
    updatedAt: nextUpdatedAt(state.updatedAt),
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
    updatedAt: nextUpdatedAt(state.updatedAt),
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
  dismissUndoToasts('buy');
  state.buys = state.buys.map((buy) => buy.deleted
    ? buy
    : { ...buy, deleted: true, updatedAt: nextUpdatedAt(buy.updatedAt) });
  showAllBuys = false;
  saveState();
  render();
});

elements.toggleBuyList.addEventListener('click', () => {
  showAllBuys = !showAllBuys;
  render();
});

elements.exportBackup.addEventListener('click', exportBackup);
elements.importBackup.addEventListener('click', () => elements.backupFile.click());
elements.backupFile.addEventListener('change', () => {
  const [file] = elements.backupFile.files;
  if (file) importBackup(file);
});
elements.signInButton.addEventListener('click', toggleGoogleSignIn);

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
initializeCloudSync();
window.setInterval(refreshQuote, hasLocalQuoteApi ? 5 * 60 * 1000 : 15 * 60 * 1000);