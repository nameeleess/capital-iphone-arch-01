'use strict';

const APP_VERSION = 'IPHONE-ARCH-01-harness-1.0.0';
const DB_NAME = 'CAPITAL_ARCH01_SPIKE';
const DB_VERSION = 1;
const SCHEMA_VERSION = 1;
const BACKUP_FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS_TEST_ONLY = 150000;
const MAIN_SLOT = 'main';
const TEST_IDS = {
  locationA: '00000000-0000-4000-8000-000000000001',
  locationB: '00000000-0000-4000-8000-000000000002',
  reserve: '00000000-0000-4000-8000-000000000003',
  eventTransfer: '00000000-0000-4000-8000-000000000004',
  movementOut: '00000000-0000-4000-8000-000000000005',
  movementIn: '00000000-0000-4000-8000-000000000006',
  payroll: '00000000-0000-4000-8000-000000000007',
  payrollEvent: '00000000-0000-4000-8000-000000000008',
  provenance: '00000000-0000-4000-8000-000000000009',
  correction: '00000000-0000-4000-8000-000000000010',
  coverage: '00000000-0000-4000-8000-000000000011'
};
const STORE_NAMES = [
  'meta', 'locations', 'reserves', 'reserveAllocations', 'events', 'movements',
  'payrolls', 'provenance', 'corrections', 'historicalCoverage', 'harnessResults'
];
const SLOT_STORES = STORE_NAMES.filter(x => !['meta', 'harnessResults'].includes(x));

let dbPromise;
let lastValidBackupEnvelope = null;
const logEl = document.getElementById('log');

function log(message, data) {
  const time = new Date().toISOString();
  const line = `[${time}] ${message}${data === undefined ? '' : `\n${JSON.stringify(data, null, 2)}`}\n`;
  logEl.textContent = line + logEl.textContent;
  console.log(message, data ?? '');
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction error'));
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('harnessResults')) db.createObjectStore('harnessResults', { keyPath: 'id' });
      for (const name of SLOT_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: ['slotId', 'id'] });
          store.createIndex('bySlot', 'slotId', { unique: false });
        }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function putMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite', { durability: 'strict' });
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

async function getMeta(key) {
  const db = await openDb();
  const tx = db.transaction('meta', 'readonly');
  return (await req(tx.objectStore('meta').get(key)))?.value;
}

async function setResult(id, status, detail, extra = {}) {
  const db = await openDb();
  const tx = db.transaction('harnessResults', 'readwrite', { durability: 'strict' });
  tx.objectStore('harnessResults').put({ id, status, detail, at: new Date().toISOString(), ...extra });
  await txDone(tx);
  await renderResults();
}

async function getResults() {
  const db = await openDb();
  const tx = db.transaction('harnessResults', 'readonly');
  const all = await req(tx.objectStore('harnessResults').getAll());
  return Object.fromEntries(all.map(x => [x.id, x]));
}

const RESULT_DEFS = {
  'IPH-AC-01': 'Home Screen App abre correctamente',
  'IPH-AC-02': 'Arranque offline correcto',
  'IPH-AC-03': 'Persistencia solicitada y estado documentado',
  'IPH-AC-04': 'Dataset íntegro tras cierre/reinicio',
  'IPH-AC-05': 'Atomicidad probada mediante fallo inducido',
  'IPH-AC-06': 'Backup guardado fuera del origen y recuperable',
  'IPH-AC-07': 'Restore desde pérdida total correcto',
  'IPH-AC-08': 'Backup corrupto rechazado sin daño',
  'IPH-AC-09': 'Migración conserva IDs/audit/procedencia + rollback',
  'IPH-AC-10': 'Invariantes sintéticos verdes'
};

async function renderResults() {
  const results = await getResults();
  const container = document.getElementById('results');
  container.innerHTML = '';
  for (const [id, label] of Object.entries(RESULT_DEFS)) {
    const r = results[id] || { status: 'PENDING', detail: 'Pendiente' };
    const row = document.createElement('div');
    row.className = 'result';
    row.innerHTML = `<strong>${id}</strong><span class="status ${r.status}">${r.status}</span><span>${escapeHtml(r.detail || label)}</span>`;
    container.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function observableVersions() {
  const ua = navigator.userAgent;
  const wk = ua.match(/AppleWebKit\/([\d.]+)/)?.[1] || null;
  const safari = ua.match(/Version\/([\d.]+)/)?.[1] || null;
  const iosRaw = ua.match(/(?:CPU iPhone OS|CPU OS) ([\d_]+)/)?.[1] || null;
  return { iOSObserved: iosRaw ? iosRaw.replaceAll('_', '.') : null, safariVersionToken: safari, appleWebKitToken: wk };
}

async function collectEnvironment() {
  let persisted = null, estimate = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch {}
  try { estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null; } catch {}
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return {
    recordedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    dbVersion: DB_VERSION,
    schemaVersion: SCHEMA_VERSION,
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    ...observableVersions(),
    standalone,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: navigator.standalone === true,
    online: navigator.onLine,
    secureContext: window.isSecureContext,
    serviceWorkerSupported: 'serviceWorker' in navigator,
    serviceWorkerControlled: !!navigator.serviceWorker?.controller,
    indexedDBSupported: 'indexedDB' in window,
    storageApiSupported: !!navigator.storage,
    persisted,
    storageEstimate: estimate,
    webCryptoSupported: !!crypto?.subtle,
    webShareSupported: !!navigator.share,
    fileShareSupported: !!navigator.canShare,
    screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
    viewport: { width: innerWidth, height: innerHeight },
    origin: location.origin,
    path: location.pathname
  };
}

async function showEnvironment() {
  const env = await collectEnvironment();
  document.getElementById('environment').textContent = JSON.stringify(env, null, 2);
  await putMeta('lastEnvironment', env);
  return env;
}

async function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    log('Service Worker registrado/listo', { scope: reg.scope });
  } catch (e) {
    log('ERROR registrando Service Worker', { name: e.name, message: e.message });
  }
}

function syntheticFixture(slotId = MAIN_SLOT) {
  const fixed = '2026-09-04T05:00:00.000Z';
  return {
    locations: [
      { slotId, id: TEST_IDS.locationA, name: 'SYNTH-A', kind: 'CASH_LOCATION', currency: 'EUR', createdAtAudit: fixed },
      { slotId, id: TEST_IDS.locationB, name: 'SYNTH-B', kind: 'CASH_LOCATION', currency: 'EUR', createdAtAudit: fixed }
    ],
    reserves: [
      { slotId, id: TEST_IDS.reserve, name: 'SYNTH-RESERVE', status: 'ACTIVE', createdAtAudit: fixed }
    ],
    reserveAllocations: [
      { slotId, id: '00000000-0000-4000-8000-000000000012', reserveId: TEST_IDS.reserve, locationId: TEST_IDS.locationA, amountMinor: 2000, currency: 'EUR', validFrom: '2026-09-04', validTo: null }
    ],
    events: [
      { slotId, id: TEST_IDS.eventTransfer, economicType: 'INTERNAL_TRANSFER', amountMinor: 7200, currency: 'EUR', occurredAt: '2026-09-04', status: 'CONFIRMED', createdAtAudit: fixed },
      { slotId, id: TEST_IDS.payrollEvent, economicType: 'EXTERNAL_INCOME_LABOR', amountMinor: 100000, currency: 'EUR', occurredAt: '2026-09-01', status: 'CONFIRMED', createdAtAudit: fixed }
    ],
    movements: [
      { slotId, id: TEST_IDS.movementOut, eventId: TEST_IDS.eventTransfer, locationId: TEST_IDS.locationA, deltaMinor: -7200, currency: 'EUR', occurredAt: '2026-09-04', status: 'CONFIRMED', createdAtAudit: fixed },
      { slotId, id: TEST_IDS.movementIn, eventId: TEST_IDS.eventTransfer, locationId: TEST_IDS.locationB, deltaMinor: 7200, currency: 'EUR', occurredAt: '2026-09-04', status: 'CONFIRMED', createdAtAudit: fixed }
    ],
    payrolls: [
      { slotId, id: TEST_IDS.payroll, period: '2026-08', eventId: TEST_IDS.payrollEvent, netMinor: 100000, currency: 'EUR', createdAtAudit: fixed }
    ],
    provenance: [
      { slotId, id: TEST_IDS.provenance, targetType: 'payroll', targetId: TEST_IDS.payroll, addressKind: 'FIELD', fieldPath: 'netMinor', epistemicClass: 'DATA', sourceKind: 'SYNTHETIC_DOCUMENT', createdAtAudit: fixed }
    ],
    corrections: [
      { slotId, id: TEST_IDS.correction, correctionType: 'RECLASSIFICATION', targets: [{ targetType: 'event', targetId: TEST_IDS.eventTransfer, addressKind: 'ENTITY' }], reason: 'Synthetic only', createdAtAudit: fixed }
    ],
    historicalCoverage: [
      { slotId, id: TEST_IDS.coverage, status: 'PARTIAL', temporalFrom: '2026-09-01', temporalTo: '2026-09-04', entityScope: ['SYNTH-A','SYNTH-B'], conceptualScope: ['MOVEMENTS'], detailScope: 'SYNTHETIC', createdAtAudit: fixed }
    ]
  };
}

async function clearSlot(slotId) {
  const db = await openDb();
  for (const storeName of SLOT_STORES) {
    const tx = db.transaction(storeName, 'readwrite', { durability: 'strict' });
    const idx = tx.objectStore(storeName).index('bySlot');
    const keys = await req(idx.getAllKeys(IDBKeyRange.only(slotId)));
    for (const key of keys) tx.objectStore(storeName).delete(key);
    await txDone(tx);
  }
}

async function writeFixture(slotId = MAIN_SLOT) {
  const fixture = syntheticFixture(slotId);
  const db = await openDb();
  const storeNames = Object.keys(fixture);
  const tx = db.transaction(storeNames, 'readwrite', { durability: 'strict' });
  for (const [storeName, records] of Object.entries(fixture)) {
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
  }
  await txDone(tx);
  await putMeta('activeSlotId', slotId);
  await putMeta('fixtureExpectedHash', await hashCanonical(fixture));
  return fixture;
}

async function readSlot(slotId = MAIN_SLOT) {
  const db = await openDb();
  const out = {};
  for (const storeName of SLOT_STORES) {
    const tx = db.transaction(storeName, 'readonly');
    const idx = tx.objectStore(storeName).index('bySlot');
    const rows = await req(idx.getAll(IDBKeyRange.only(slotId)));
    rows.sort((a,b) => a.id.localeCompare(b.id));
    out[storeName] = rows;
  }
  return out;
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableSort(value[key]);
    return out;
  }
  return value;
}

async function hashCanonical(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableSort(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validateSlot(slotId = MAIN_SLOT) {
  const data = await readSlot(slotId);
  const errors = [];
  const ids = Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, new Set(rows.map(r => r.id))]));
  for (const m of data.movements) {
    if (!ids.events.has(m.eventId)) errors.push(`movement ${m.id} -> missing event ${m.eventId}`);
    if (!ids.locations.has(m.locationId)) errors.push(`movement ${m.id} -> missing location ${m.locationId}`);
    if (!Number.isSafeInteger(m.deltaMinor)) errors.push(`movement ${m.id} deltaMinor not safe integer`);
  }
  for (const a of data.reserveAllocations) {
    if (!ids.reserves.has(a.reserveId)) errors.push(`allocation ${a.id} -> missing reserve ${a.reserveId}`);
    if (!ids.locations.has(a.locationId)) errors.push(`allocation ${a.id} -> missing location ${a.locationId}`);
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor < 0) errors.push(`allocation ${a.id} invalid amount`);
  }
  for (const p of data.payrolls) {
    if (p.eventId && !ids.events.has(p.eventId)) errors.push(`payroll ${p.id} -> missing event ${p.eventId}`);
  }
  const transfers = data.events.filter(e => e.economicType === 'INTERNAL_TRANSFER');
  for (const e of transfers) {
    const deltas = data.movements.filter(m => m.eventId === e.id).reduce((sum,m) => sum + m.deltaMinor, 0);
    if (deltas !== 0) errors.push(`transfer ${e.id} net delta ${deltas}`);
  }
  const allocationByLocation = new Map();
  for (const a of data.reserveAllocations.filter(x => x.validTo == null)) {
    allocationByLocation.set(a.locationId, (allocationByLocation.get(a.locationId) || 0) + a.amountMinor);
  }
  // Synthetic fixture assigns 20 EUR to location A; it has enough conceptual balance by construction.
  if ((allocationByLocation.get(TEST_IDS.locationA) || 0) > 100000) errors.push('synthetic allocation exceeds fixture capacity');
  return { ok: errors.length === 0, errors, data, hash: await hashCanonical(data) };
}

async function testP1() {
  const env = await collectEnvironment();
  const ok = env.standalone && env.secureContext && env.serviceWorkerSupported;
  await setResult('IPH-AC-01', ok ? 'PASS' : 'FAIL', ok ? 'Ejecutándose como Home Screen Web App en contexto seguro.' : 'No está en modo standalone/Home Screen o falta contexto seguro.', { env });
  log('P1 ejecutada', { ok, env });
  if (!ok) throw new Error('P1 FAIL');
}

async function testP2() {
  const env = await collectEnvironment();
  const ok = env.standalone && env.online === false && env.serviceWorkerControlled;
  await setResult('IPH-AC-02', ok ? 'PASS' : 'FAIL', ok ? 'La web app se abrió offline y está controlada por Service Worker.' : 'Debe ejecutarse offline, standalone y con Service Worker controlando la página.', { env });
  log('P2 ejecutada', { ok, env });
  if (!ok) throw new Error('P2 FAIL');
}

async function testP3() {
  let before = null, requestResult = null, after = null, estimate = null;
  if (!navigator.storage?.persisted) {
    await setResult('IPH-AC-03', 'FAIL', 'StorageManager.persisted() no disponible.');
    throw new Error('Storage API no disponible');
  }
  before = await navigator.storage.persisted();
  if (!before && navigator.storage.persist) requestResult = await navigator.storage.persist();
  after = await navigator.storage.persisted();
  estimate = navigator.storage.estimate ? await navigator.storage.estimate() : null;
  await putMeta('persistenceEvidence', { before, requestResult, after, estimate, at: new Date().toISOString() });
  await setResult('IPH-AC-03', 'PASS', `persisted antes=${before}; request=${requestResult}; después=${after}. Se registra como evidencia, no como garantía.`, { before, requestResult, after, estimate });
  log('P3 ejecutada', { before, requestResult, after, estimate });
  await showEnvironment();
}

async function testP4Create() {
  await clearSlot(MAIN_SLOT);
  const fixture = await writeFixture(MAIN_SLOT);
  const v = await validateSlot(MAIN_SLOT);
  if (!v.ok) throw new Error(`Fixture inválido: ${v.errors.join('; ')}`);
  await putMeta('fixtureManifest', { createdAt: new Date().toISOString(), expectedCanonical: stableSort(fixture) });
  log('P4 fixture sintético creado', { hash: v.hash });
  alert('Fixture sintético creado. Ahora cierra por completo la web app, vuelve a abrirla y usa “P4 · Verificar fixture persistido”.');
}

async function testP4Verify() {
  const manifest = await getMeta('fixtureManifest');
  if (!manifest) {
    await setResult('IPH-AC-04', 'FAIL', 'No existe manifest previo: primero crea el fixture y reinicia la app.');
    throw new Error('Sin fixture manifest');
  }
  const actual = await readSlot(MAIN_SLOT);
  const expected = {};
  for (const name of SLOT_STORES) expected[name] = (manifest.expectedCanonical[name] || []).slice().sort((a,b)=>a.id.localeCompare(b.id));
  const actualHash = await hashCanonical(actual);
  const expectedHash = await hashCanonical(expected);
  const v = await validateSlot(MAIN_SLOT);
  const ok = v.ok && actualHash === expectedHash;
  await setResult('IPH-AC-04', ok ? 'PASS' : 'FAIL', ok ? 'Dataset idéntico al fixture esperado tras cierre/reapertura.' : `Hash/integridad no coincide. expected=${expectedHash}, actual=${actualHash}`, { expectedHash, actualHash, errors: v.errors });
  await setResult('IPH-AC-10', v.ok ? 'PASS' : 'FAIL', v.ok ? 'Invariantes sintéticos del fixture verdes.' : v.errors.join('; '), { errors: v.errors });
  log('P4 verificación', { ok, expectedHash, actualHash, errors: v.errors });
  if (!ok) throw new Error('P4 FAIL');
}

async function testP5() {
  const db = await openDb();
  const eventId = 'atomic-event';
  const moveId = 'atomic-movement';
  // Clean prior test rows.
  for (const [storeName, id] of [['events',eventId],['movements',moveId]]) {
    const tx = db.transaction(storeName, 'readwrite', { durability: 'strict' });
    tx.objectStore(storeName).delete([MAIN_SLOT,id]);
    await txDone(tx);
  }
  const tx = db.transaction(['events','movements'], 'readwrite', { durability: 'strict' });
  tx.objectStore('events').put({ slotId: MAIN_SLOT, id: eventId, economicType:'INTERNAL_TRANSFER', amountMinor: 100, currency:'EUR', status:'CONFIRMED' });
  tx.objectStore('movements').put({ slotId: MAIN_SLOT, id: moveId, eventId, locationId: TEST_IDS.locationA, deltaMinor:-100, currency:'EUR', status:'CONFIRMED' });
  tx.abort();
  try { await txDone(tx); } catch (_) {}
  const verifyTx = db.transaction(['events','movements'], 'readonly');
  const e = await req(verifyTx.objectStore('events').get([MAIN_SLOT,eventId]));
  const m = await req(verifyTx.objectStore('movements').get([MAIN_SLOT,moveId]));
  const ok = !e && !m;
  await setResult('IPH-AC-05', ok ? 'PASS' : 'FAIL', ok ? 'Transacción abortada sin escritura parcial.' : 'Se detectó escritura parcial tras abort().', { eventPresent: !!e, movementPresent: !!m });
  log('P5 atomicidad', { ok, eventPresent: !!e, movementPresent: !!m });
  if (!ok) throw new Error('P5 FAIL');
}

function bytesToBase64(bytes) {
  let binary = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let i=0;i<u8.length;i+=chunk) binary += String.fromCharCode(...u8.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBackupKey(secret, salt, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', hash:'SHA-256', salt, iterations },
    baseKey,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']
  );
}

async function exportCanonicalPayload() {
  const activeSlotId = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const data = await readSlot(activeSlotId);
  const results = await getResults();
  return {
    payloadKind: 'CAPITAL_ARCH01_SYNTHETIC_ONLY',
    schemaVersion: SCHEMA_VERSION,
    activeSlotId,
    exportedAt: new Date().toISOString(),
    data,
    harnessResults: results,
    fixtureManifest: await getMeta('fixtureManifest'),
    persistenceEvidence: await getMeta('persistenceEvidence')
  };
}

async function createEncryptedBackup(secret) {
  const payload = await exportCanonicalPayload();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(secret, salt, PBKDF2_ITERATIONS_TEST_ONLY);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const start = performance.now();
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv, tagLength:128 }, key, plaintext));
  const ms = performance.now() - start;
  const envelope = {
    magic: 'CAPITAL-ARCH01-BACKUP',
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    crypto: {
      cipher: 'AES-GCM-256',
      kdf: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS_TEST_ONLY,
      saltB64: bytesToBase64(salt),
      ivB64: bytesToBase64(iv),
      tagLength: 128,
      testOnlyParameters: true
    },
    ciphertextB64: bytesToBase64(ciphertext),
    ciphertextSha256: await hashCanonical(bytesToBase64(ciphertext))
  };
  lastValidBackupEnvelope = envelope;
  log('Backup cifrado generado', { bytes: ciphertext.byteLength, encryptMs: Math.round(ms), envelope: { ...envelope, ciphertextB64: '[omitted]' } });
  return envelope;
}

async function shareOrDownload(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type:'application/json' });
  const file = new File([blob], filename, { type:'application/json' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files:[file] })) {
    try {
      await navigator.share({ files:[file], title: filename, text:'IPHONE-ARCH-01 · datos exclusivamente sintéticos' });
      log('Archivo enviado mediante share sheet', { filename });
      return { method:'share', filename };
    } catch (e) {
      if (e.name !== 'AbortError') log('Share falló; se usará descarga', { name:e.name, message:e.message });
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log('Archivo ofrecido como descarga', { filename });
  return { method:'download', filename };
}

async function testP6Valid() {
  const secret = document.getElementById('secret').value;
  if (secret.length < 20) throw new Error('Usa el secreto sintético predefinido; es solo para el spike.');
  const env = await createEncryptedBackup(secret);
  const delivery = await shareOrDownload(env, `capital-arch01-valid-${Date.now()}.capital-arch01-test.json`);
  await setResult('IPH-AC-06', 'PENDING', `Backup generado por ${delivery.method}. Solo pasará cuando se restaure después de pérdida total usando el archivo externo.`, { delivery });
  alert('Guarda el archivo en Archivos (idealmente “En mi iPhone” o iCloud Drive). Todavía NO marca P6 como PASS: eso ocurrirá al restaurarlo tras pérdida total.');
}

async function testP6Corrupt() {
  if (!lastValidBackupEnvelope) {
    const secret = document.getElementById('secret').value;
    lastValidBackupEnvelope = await createEncryptedBackup(secret);
  }
  const corrupted = structuredClone(lastValidBackupEnvelope);
  const bytes = base64ToBytes(corrupted.ciphertextB64);
  if (bytes.length < 1) throw new Error('Ciphertext vacío');
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  corrupted.ciphertextB64 = bytesToBase64(bytes);
  corrupted.corruptionInjected = true;
  await shareOrDownload(corrupted, `capital-arch01-corrupt-${Date.now()}.capital-arch01-test.json`);
  alert('Guarda también este archivo corrupto en Archivos. Se usará en P9 después del restore válido.');
}

async function countMainData() {
  const slot = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const data = await readSlot(slot);
  return Object.values(data).reduce((sum, rows) => sum + rows.length, 0);
}

async function testP7() {
  const count = await countMainData();
  const fixtureManifest = await getMeta('fixtureManifest');
  const ok = count === 0 && !fixtureManifest;
  await setResult('IPH-AC-07', 'PENDING', ok ? 'Pérdida total observada: no hay dataset local. P8 debe restaurar desde archivo externo para completar AC-07.' : `Aún existen ${count} registros o manifest local. Debes eliminar completamente los datos de esta web app antes de P7.`, { count, fixtureManifestPresent: !!fixtureManifest });
  log('P7 pérdida total', { ok, count, fixtureManifestPresent: !!fixtureManifest });
  if (!ok) throw new Error('P7 todavía no demuestra pérdida total');
  alert('Pérdida total confirmada. Ahora selecciona el backup válido desde Archivos y ejecuta P8.');
}

async function loadSelectedEnvelope() {
  const input = document.getElementById('backupFile');
  const file = input.files?.[0];
  if (!file) throw new Error('Selecciona primero un archivo de backup.');
  const text = await file.text();
  const obj = JSON.parse(text);
  return { file, obj };
}

async function decryptEnvelope(envelope, secret) {
  if (envelope.magic !== 'CAPITAL-ARCH01-BACKUP') throw new Error('Magic de backup inválido');
  if (envelope.backupFormatVersion !== 1) throw new Error(`backupFormatVersion no soportada: ${envelope.backupFormatVersion}`);
  const salt = base64ToBytes(envelope.crypto.saltB64);
  const iv = base64ToBytes(envelope.crypto.ivB64);
  const ciphertext = base64ToBytes(envelope.ciphertextB64);
  const key = await deriveBackupKey(secret, salt, envelope.crypto.iterations);
  const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv, tagLength: envelope.crypto.tagLength || 128 }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function mergeResultsFromBackup(resultsObj) {
  if (!resultsObj) return;
  const db = await openDb();
  const tx = db.transaction('harnessResults', 'readwrite', { durability:'strict' });
  for (const r of Object.values(resultsObj)) {
    if (!r?.id) continue;
    const currentReq = tx.objectStore('harnessResults').get(r.id);
    // Keep it simple: backup contains only P1-P6-era results. P7+ current entries will be written after reset.
    currentReq.onsuccess = () => {
      if (!currentReq.result) tx.objectStore('harnessResults').put(r);
    };
  }
  await txDone(tx);
}

async function restorePayloadToStaging(payload) {
  if (payload.payloadKind !== 'CAPITAL_ARCH01_SYNTHETIC_ONLY') throw new Error('Payload no pertenece al arnés sintético');
  if (payload.schemaVersion !== 1) throw new Error(`Schema no soportado en spike: ${payload.schemaVersion}`);
  const stagingSlot = `restore-${crypto.randomUUID()}`;
  const db = await openDb();
  const storeNames = SLOT_STORES;
  const tx = db.transaction(storeNames, 'readwrite', { durability:'strict' });
  for (const storeName of storeNames) {
    const rows = payload.data?.[storeName] || [];
    for (const row of rows) tx.objectStore(storeName).put({ ...row, slotId: stagingSlot });
  }
  await txDone(tx);
  const validation = await validateSlot(stagingSlot);
  if (!validation.ok) {
    await clearSlot(stagingSlot);
    throw new Error(`Staging inválido: ${validation.errors.join('; ')}`);
  }
  return { stagingSlot, validation };
}

async function activateSlot(slotId) {
  await putMeta('activeSlotId', slotId);
}

async function testP8() {
  const beforeCount = await countMainData();
  const currentP7 = (await getResults())['IPH-AC-07'];
  if (!currentP7 || currentP7.status !== 'PENDING' || !String(currentP7.detail).startsWith('Pérdida total observada')) {
    throw new Error('P8 requiere ejecutar P7 tras una pérdida total real del storage del arnés.');
  }
  const { file, obj } = await loadSelectedEnvelope();
  const secret = document.getElementById('secret').value;
  const payload = await decryptEnvelope(obj, secret);
  const { stagingSlot, validation } = await restorePayloadToStaging(payload);
  await activateSlot(stagingSlot);
  await putMeta('fixtureManifest', payload.fixtureManifest || null);
  await putMeta('persistenceEvidence', payload.persistenceEvidence || null);
  await mergeResultsFromBackup(payload.harnessResults);
  const after = await validateSlot(stagingSlot);
  const restoredCount = Object.values(after.data).reduce((s,r)=>s+r.length,0);
  const ok = validation.ok && after.ok && restoredCount > 0 && beforeCount === 0;
  await setResult('IPH-AC-06', ok ? 'PASS' : 'FAIL', ok ? `Archivo externo “${file.name}” restauró el dataset después de pérdida total.` : 'No se pudo demostrar backup externo recuperable.', { fileName:file.name, beforeCount, restoredCount });
  await setResult('IPH-AC-07', ok ? 'PASS' : 'FAIL', ok ? `Restore completo desde pérdida total a slot ${stagingSlot}.` : 'Restore falló.', { stagingSlot, restoredCount, errors: after.errors });
  await setResult('IPH-AC-10', after.ok ? 'PASS' : 'FAIL', after.ok ? 'Invariantes verdes tras restore.' : after.errors.join('; '));
  log('P8 restore', { ok, file:file.name, stagingSlot, beforeCount, restoredCount, errors:after.errors });
  if (!ok) throw new Error('P8 FAIL');
}

async function testP9() {
  const beforeSlot = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const before = await validateSlot(beforeSlot);
  const beforeHash = before.hash;
  const { file, obj } = await loadSelectedEnvelope();
  const secret = document.getElementById('secret').value;
  let rejected = false;
  let errorText = '';
  try {
    await decryptEnvelope(obj, secret);
  } catch (e) {
    rejected = true;
    errorText = `${e.name}: ${e.message}`;
  }
  const afterSlot = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const after = await validateSlot(afterSlot);
  const ok = rejected && beforeSlot === afterSlot && beforeHash === after.hash && after.ok;
  await setResult('IPH-AC-08', ok ? 'PASS' : 'FAIL', ok ? `Backup corrupto “${file.name}” rechazado y dataset activo intacto.` : 'El rechazo o la preservación del dataset no quedaron demostrados.', { rejected, errorText, beforeSlot, afterSlot, beforeHash, afterHash:after.hash });
  log('P9 corrupción', { ok, rejected, errorText, beforeSlot, afterSlot, beforeHash, afterHash:after.hash });
  if (!ok) throw new Error('P9 FAIL');
}

async function testP10() {
  const mainSlot = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const mainBefore = await validateSlot(mainSlot);
  const oldSlot = `mig-v0-${crypto.randomUUID()}`;
  const newSlot = `mig-v1-${crypto.randomUUID()}`;
  const oldId = '00000000-0000-4000-8000-00000000a001';
  const provId = '00000000-0000-4000-8000-00000000a002';
  const fixed = '2026-09-04T05:00:00.000Z';
  const db = await openDb();
  // v0 fixture: amountCents, no slot schema change required; migration code interprets legacy shape.
  {
    const tx = db.transaction(['events','provenance'], 'readwrite', { durability:'strict' });
    tx.objectStore('events').put({ slotId: oldSlot, id: oldId, economicType:'REAL_EXPENSE', amountCents:1234, currency:'EUR', status:'CONFIRMED', createdAtAudit:fixed, legacySchemaVersion:0 });
    tx.objectStore('provenance').put({ slotId: oldSlot, id: provId, targetType:'event', targetId:oldId, addressKind:'FIELD', fieldPath:'amountCents', epistemicClass:'DATA', sourceKind:'SYNTHETIC_LEGACY', createdAtAudit:fixed, legacySchemaVersion:0 });
    await txDone(tx);
  }
  // Recovery point = oldSlot. Build staging v1 preserving IDs and audit fields.
  {
    const rtx = db.transaction(['events','provenance'], 'readonly');
    const oldEvent = await req(rtx.objectStore('events').get([oldSlot,oldId]));
    const oldProv = await req(rtx.objectStore('provenance').get([oldSlot,provId]));
    const wtx = db.transaction(['events','provenance'], 'readwrite', { durability:'strict' });
    wtx.objectStore('events').put({ slotId:newSlot, id:oldEvent.id, economicType:oldEvent.economicType, amountMinor:oldEvent.amountCents, currency:oldEvent.currency, status:oldEvent.status, createdAtAudit:oldEvent.createdAtAudit, migratedFromSchemaVersion:0 });
    wtx.objectStore('provenance').put({ slotId:newSlot, id:oldProv.id, targetType:oldProv.targetType, targetId:oldProv.targetId, addressKind:oldProv.addressKind, fieldPath:'amountMinor', epistemicClass:oldProv.epistemicClass, sourceKind:oldProv.sourceKind, createdAtAudit:oldProv.createdAtAudit, migratedFromSchemaVersion:0 });
    await txDone(wtx);
  }
  const ntx = db.transaction(['events','provenance'], 'readonly');
  const newEvent = await req(ntx.objectStore('events').get([newSlot,oldId]));
  const newProv = await req(ntx.objectStore('provenance').get([newSlot,provId]));
  const preserved = newEvent?.id === oldId && newEvent?.amountMinor === 1234 && newEvent?.createdAtAudit === fixed && newProv?.id === provId && newProv?.targetId === oldId && newProv?.fieldPath === 'amountMinor';
  await activateSlot(newSlot);
  const activated = (await getMeta('activeSlotId')) === newSlot;
  // Rollback to recovery point, then back to original main slot to leave user state intact.
  await activateSlot(oldSlot);
  const rolledBack = (await getMeta('activeSlotId')) === oldSlot;
  await activateSlot(mainSlot);
  const mainAfter = await validateSlot(mainSlot);
  const mainIntact = mainAfter.ok && mainAfter.hash === mainBefore.hash;
  const ok = preserved && activated && rolledBack && mainIntact;
  await setResult('IPH-AC-09', ok ? 'PASS' : 'FAIL', ok ? 'Migración sintética v0→v1 preservó IDs/audit/procedencia; activación y rollback por slot correctos.' : 'Falló preservación, activación, rollback o integridad del dataset principal.', { oldSlot, newSlot, preserved, activated, rolledBack, mainIntact, mainBeforeHash:mainBefore.hash, mainAfterHash:mainAfter.hash });
  log('P10 migración/rollback', { ok, oldSlot, newSlot, preserved, activated, rolledBack, mainIntact });
  await clearSlot(oldSlot);
  await clearSlot(newSlot);
  if (!ok) throw new Error('P10 FAIL');
}

async function exportEvidence() {
  const env = await collectEnvironment();
  const results = await getResults();
  const activeSlot = (await getMeta('activeSlotId')) || MAIN_SLOT;
  const validation = await validateSlot(activeSlot).catch(e => ({ok:false, errors:[e.message], hash:null}));
  const report = {
    report: 'INFORME_RAW_IPHONE_ARCH_01',
    harnessVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    environment: env,
    results,
    activeSlot,
    datasetIntegrity: { ok: validation.ok, errors: validation.errors, hash: validation.hash },
    persistenceEvidence: await getMeta('persistenceEvidence'),
    notes: 'Datos exclusivamente sintéticos. Este archivo contiene evidencia técnica del spike, no datos de CAPITAL APP.'
  };
  await shareOrDownload(report, `iphone-arch-01-evidence-${Date.now()}.json`);
  log('Informe de evidencia exportado');
}

async function resetHarnessResults() {
  if (!confirm('¿Reiniciar SOLO los resultados del arnés? No borra el fixture financiero sintético.')) return;
  const db = await openDb();
  const tx = db.transaction('harnessResults','readwrite',{durability:'strict'});
  tx.objectStore('harnessResults').clear();
  await txDone(tx);
  await renderResults();
  log('Resultados reiniciados');
}

function guard(fn) {
  return async () => {
    try { await fn(); }
    catch (e) {
      log('ERROR', { name:e.name, message:e.message, stack:e.stack });
      alert(`${e.name}: ${e.message}`);
    }
  };
}

document.getElementById('refreshEnv').addEventListener('click', guard(showEnvironment));
document.getElementById('p1').addEventListener('click', guard(testP1));
document.getElementById('p2').addEventListener('click', guard(testP2));
document.getElementById('p3').addEventListener('click', guard(testP3));
document.getElementById('p4create').addEventListener('click', guard(testP4Create));
document.getElementById('p4verify').addEventListener('click', guard(testP4Verify));
document.getElementById('p5').addEventListener('click', guard(testP5));
document.getElementById('p6valid').addEventListener('click', guard(testP6Valid));
document.getElementById('p6corrupt').addEventListener('click', guard(testP6Corrupt));
document.getElementById('p7status').addEventListener('click', guard(testP7));
document.getElementById('p8').addEventListener('click', guard(testP8));
document.getElementById('p9').addEventListener('click', guard(testP9));
document.getElementById('p10').addEventListener('click', guard(testP10));
document.getElementById('exportEvidence').addEventListener('click', guard(exportEvidence));
document.getElementById('resetResults').addEventListener('click', guard(resetHarnessResults));

window.addEventListener('online', showEnvironment);
window.addEventListener('offline', showEnvironment);

(async function init() {
  await registerSW();
  await openDb();
  if ((await getMeta('activeSlotId')) == null) await putMeta('activeSlotId', MAIN_SLOT);
  await showEnvironment();
  await renderResults();
  log('Arnés inicializado', { APP_VERSION, DB_VERSION, SCHEMA_VERSION });
})();
