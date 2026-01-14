(() => {
  
  const PROBE_TIMEOUT = 8000; 
  const MAX_ATTEMPTS = 30;
  const MAX_SERVER_NUM = 15;
  const RETRY_DELAY = 700; 
  const CHECK_DELAY = 200;
  const K_PREEMPTIVE_VERIFY_DELAY = 800;
  const ERROR_EVENT_DEBOUNCE = 100;
  const ATTR_CHANGE_RESCAN_DELAY = 500;
  const PERSIST_DEBOUNCE_DELAY = 250;

  const SLOW_LOAD_PREEMPT_DELAY = 1400;
  const SLOW_LOAD_PREEMPT_TRIES = 4;

  const PROBE_PARALLEL = 3;
  const PROBE_PARALLEL_TRIES = 9;

  const STORAGE_KEY = 'batoFixCacheV1';
  const CACHE_VERSION = 3;
  const HOST_CACHE_MAX = 250;
  const URL_CACHE_MAX = 800;

  const BEST_HOST_STATS_KEY = 'batoBestFullHostStatsV1';
  const BEST_HOST_STATS_MAX = 250;

  const PREFIX_PRIORITY_MB = ['n', 's', 'b', 'd'];
  const PREFIX_PRIORITY_MP = ['n', 's', 'b', 'd'];
  const EXTRA_PREFIXES = ['x', 't', 'w', 'm', 'c', 'u', 'k'];

  const BEST_FULL_HOSTS = `
    b01.mbimg.org b01.mbmyj.org b01.mbrtz.org b01.mbtba.org b01.mbwnp.org b01.mbxma.org b01.mbznp.org
    d01.mbdny.org d01.mbimg.org d01.mbmyj.org d01.mbuul.org
    n00.mbdny.org n00.mbqgu.org n00.mbuul.org n00.mbwnp.org
    n01.mbdny.org n01.mbopg.org n01.mbwww.org n01.mbxma.org
    n02.mbeaj.org n02.mbmyj.org n02.mbtmv.org n02.mbwbm.org n02.mbxma.org
    n03.mbhiz.org
    n04.mbdny.org n04.mbeaj.org n04.mbhiz.org n04.mbimg.org n04.mbqgu.org n04.mbtmv.org n04.mbxma.org n04.mbzcp.org n04.mbznp.org
    n05.mbimg.org n05.mbmyj.org n05.mbuul.org n05.mbznp.org
    n06.mbeaj.org n06.mbrtz.org n06.mbwbm.org n06.mbwww.org
    n07.mbmyj.org n07.mbopg.org n07.mbqgu.org n07.mbrtz.org n07.mbtba.org n07.mbtmv.org n07.mbwnp.org n07.mbxma.org
    n08.mbhiz.org
    n09.mbfpu.org n09.mbhiz.org n09.mbzcp.org
    n10.mbfpu.org n10.mbuul.org n10.mbwnp.org n10.mbwww.org n10.mbzcp.org n10.mbznp.org
    n11.mbopg.org n11.mbwnp.org n11.mbwww.org n11.mbxma.org
    n12.mbfpu.org n12.mbwbm.org
    n14.mbmyj.org n14.mbxma.org
    n15.mbfpu.org
    s00.mpubn.org s03.mpqsc.org s03.mpypl.org s05.mpfip.org s06.mpqsc.org s06.mprnm.org s07.mpfip.org s09.mpfip.org s09.mpubn.org s10.mpmok.org s10.mprnm.org
  `.trim().split(/\s+/);

  const bestHostStats = new Map();
  let bestHostStatsTimer = null;

  const bestHostPreflightPromises = new Map();

  function pruneBestHostStats(maxEntries) {
    if (bestHostStats.size <= maxEntries) return;
    const entries = Array.from(bestHostStats.entries());
    entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    const toRemove = entries.slice(0, Math.max(0, bestHostStats.size - maxEntries));
    for (const [k] of toRemove) bestHostStats.delete(k);
  }

  function loadBestHostStats() {
    try {
      const raw = localStorage.getItem(BEST_HOST_STATS_KEY);
      if (!raw) return;
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
      for (const [host, entry] of Object.entries(stats)) {
        if (!host || typeof host !== 'string') continue;
        if (!BEST_FULL_HOSTS.includes(host)) continue;
        if (!entry || typeof entry !== 'object') continue;
        const hits = typeof entry.hits === 'number' ? entry.hits : 0;
        const fails = typeof entry.fails === 'number' ? entry.fails : 0;
        const lastUsed = typeof entry.lastUsed === 'number' ? entry.lastUsed : 0;
        bestHostStats.set(host, {
          hits: Math.max(0, hits),
          fails: Math.max(0, fails),
          lastUsed
        });
      }
      pruneBestHostStats(BEST_HOST_STATS_MAX);
    } catch {
    }
  }

  function persistBestHostStatsNow() {
    try {
      pruneBestHostStats(BEST_HOST_STATS_MAX);
      const statsObj = {};
      for (const [host, meta] of bestHostStats.entries()) {
        statsObj[host] = {
          hits: meta.hits || 0,
          fails: meta.fails || 0,
          lastUsed: meta.lastUsed || 0
        };
      }
      const payload = {
        version: 1,
        savedAt: nowMs(),
        stats: statsObj
      };
      localStorage.setItem(BEST_HOST_STATS_KEY, JSON.stringify(payload));
    } catch {
    }
  }

  function scheduleBestHostStatsPersist() {
    try {
      if (bestHostStatsTimer) return;
      bestHostStatsTimer = setTimeout(() => {
        bestHostStatsTimer = null;
        persistBestHostStatsNow();
      }, PERSIST_DEBOUNCE_DELAY);
    } catch {
    }
  }

  function getBestHostMeta(host) {
    const existing = bestHostStats.get(host);
    if (existing) return existing;
    const meta = { hits: 0, fails: 0, lastUsed: 0 };
    bestHostStats.set(host, meta);
    return meta;
  }

  function recordBestHostSuccess(host) {
    if (!host) return;
    const meta = getBestHostMeta(host);
    meta.hits = (meta.hits || 0) + 1;
    meta.lastUsed = nowMs();
    scheduleBestHostStatsPersist();
  }

  function recordBestHostFailure(host, reason) {
    if (!host) return;
    if (reason === 'cached-fail') return;
    const meta = getBestHostMeta(host);
    meta.fails = (meta.fails || 0) + 1;
    meta.lastUsed = nowMs();
    scheduleBestHostStatsPersist();
  }

  function bestHostScore(meta) {
    const hits = meta && typeof meta.hits === 'number' ? meta.hits : 0;
    const fails = meta && typeof meta.fails === 'number' ? meta.fails : 0;
    // Laplace smoothing so new hosts start neutral (0.5).
    return (hits + 1) / (hits + fails + 2);
  }

  function pickBestHostByStats(hosts) {
    const pool = Array.isArray(hosts) ? hosts : [];
    if (pool.length === 0) return null;

    // Prefer hosts not currently in backoff.
    const available = pool.filter(h => {
      const base = `https://${h}`;
      return !isTemporarilyFailedHost(base);
    });
    const candidates = available.length ? available : pool;

    let best = [];
    let bestScore = -1;
    let bestHits = -1;
    for (const host of candidates) {
      const meta = bestHostStats.get(host) || { hits: 0, fails: 0, lastUsed: 0 };
      const score = bestHostScore(meta);
      const hits = meta.hits || 0;
      if (score > bestScore || (score === bestScore && hits > bestHits)) {
        bestScore = score;
        bestHits = hits;
        best = [host];
      } else if (score === bestScore && hits === bestHits) {
        best.push(host);
      }
    }
    if (best.length === 0) return null;
    return best[Math.floor(Math.random() * best.length)];
  }

  function pickRandomDistinct(arr, count) {
    const a = Array.isArray(arr) ? arr.slice() : [];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a.slice(0, Math.max(0, Math.min(count, a.length)));
  }

  async function tryBestFullHostsPreflight(parsed, tries = 4) {
    if (!parsed) return null;
    if (!BEST_FULL_HOSTS || BEST_FULL_HOSTS.length === 0) return null;

    const first = pickBestHostByStats(BEST_FULL_HOSTS);
    const restPool = first ? BEST_FULL_HOSTS.filter(h => h !== first) : BEST_FULL_HOSTS;
    const rest = pickRandomDistinct(restPool, Math.max(0, tries - 1));
    const picks = first ? [first, ...rest] : rest;

    for (const host of picks) {
      const url = `https://${host}${parsed.path}`;
      try {
        const timeout = Math.min(PROBE_TIMEOUT, 3500);
        await probeUrl(url, timeout);
        const okParsed = parseSubdomain(url);
        if (!okParsed) continue;
        recordBestHostSuccess(host);
        return toHostTuple(okParsed);
      } catch (e) {
        recordBestHostFailure(host, e);
      }
    }
    return null;
  }

  function isInOrNearViewport(el) {
    try {
      const r = el.getBoundingClientRect();
      const vh = Math.max(1, window.innerHeight || 1);
      return r.bottom > -vh * 0.5 && r.top < vh * 1.5;
    } catch {
      return true;
    }
  }

  async function bestHostPreflightAndSwarm(parsed) {
    const badBase = toBase(parsed);
    if (swarmHostMap.has(badBase)) return swarmHostMap.get(badBase);

    const existing = bestHostPreflightPromises.get(badBase);
    if (existing) return await existing;

    const p = (async () => {
      const tuple = await tryBestFullHostsPreflight(parsed, SLOW_LOAD_PREEMPT_TRIES);
      if (!tuple) return null;

      return commitSwarmWin(badBase, tuple, parsed, true);
    })().finally(() => {
      bestHostPreflightPromises.delete(badBase);
    });

    bestHostPreflightPromises.set(badBase, p);
    return await p;
  }

  function commitSwarmWin(badBase, tuple, parsed, mpStrict = false) {
    swarmHostMap.set(badBase, tuple);

    if (isMpRootLabel(parsed.root) && (!mpStrict || isMpRootLabel(tuple.root))) {
      setMpFamilyWinner(tuple);
      broadcastMpFamilyPreemptive(tuple);
    }

    const updatedImgs = broadcastSwarmFix(badBase, tuple);
    for (const img of updatedImgs) setTimeout(() => checkImage(img), CHECK_DELAY);

    setTimeout(() => {
      try {
        persistentHostMeta.set(badBase, { host: tuple, lastUsed: nowMs() });
        schedulePersist();
      } catch {
      }
      try {
        serverCache.set(serverCacheKey(parsed), tuple);
      } catch {
      }
    }, 0);

    return tuple;
  }

  function scheduleSlowLoadBestHostPreflight(img, parsed) {
    if (!img || !parsed) return;
    if (!BEST_FULL_HOSTS || BEST_FULL_HOSTS.length === 0) return;
    if (img.dataset.batoSlowPreflight === '1') return;
    if (!isInOrNearViewport(img)) return;

    img.dataset.batoSlowPreflight = '1';
    const expectedSrc = img.src;
    setTimeout(async () => {
      try {
        if (!img.isConnected) return;
        if (img.src !== expectedSrc) return;
        if (img.dataset.batoFixed === 'true' || img.dataset.batoFixing === 'done') return;
        if (applyExactUrlFixIfAny(img)) return;

        const p = parseSubdomain(img.src);
        if (!p) return;

        const badBase = toBase(p);
        if (swarmHostMap.has(badBase)) return;

        // If it's still not loaded, treat it as high-risk and try the fast preflight.
        if (img.complete && img.naturalWidth > 0) return;
        if (!img.complete || (img.complete && img.naturalWidth === 0)) {
          await bestHostPreflightAndSwarm(p);
        }
      } catch {
      }
    }, SLOW_LOAD_PREEMPT_DELAY);
  }

  const PREFERRED_NUM_ORDER_MP = [1, 10, 2, 5, 0, 6, 7, 8, 3, 4, 9, 12, 14, 15, 11, 13];
  const PREFERRED_NUM_ORDER_MB = [1, 0, 9, 2, 8, 7, 5, 4, 3, 10, 6, 11, 12, 15, 14, 13];

  const ROOT_PRIORITY_MP = `
    mbwww.org mbwbm.org mbuul.org mbfpu.org mbzcp.org mbqgu.org mbxma.org mbeaj.org mbrtz.org mbhiz.org mbopg.org mbdny.org
    mbznp.org mbwnp.org mbtmv.org mbimg.org mbmyj.org mbtba.org
    mprnm.org mpubn.org mpfip.org mpmok.org mpypl.org mpizz.org mpujj.org mpvim.org mpqom.org mpqsc.org
  `.trim().split(/\s+/);

  const ROOT_PRIORITY_MB = `
    mbqgu.org mbwbm.org mbrtz.org mbdny.org mbopg.org mbwnp.org mbznp.org mbfpu.org mbmyj.org mbwww.org mbzcp.org mbtmv.org
    mbhiz.org mbuul.org mbxma.org mbeaj.org mbimg.org mpizz.org mbtba.org mpfip.org mpvim.org mpmok.org mpubn.org mprnm.org
    mpypl.org mpqom.org mpujj.org mpqsc.org
  `.trim().split(/\s+/);

  const ALL_ROOTS = `
    mbdny.org mbrtz.org mbwbm.org mbznp.org mbqgu.org mbtba.org mbhiz.org mbwnp.org mbxma.org mbwww.org mbmyj.org
    mbeaj.org mbzcp.org mbuul.org mbtmv.org mbimg.org mbopg.org mbfpu.org
    mpfip.org mpizz.org mpmok.org mpqom.org mpqsc.org mprnm.org mpubn.org mpujj.org mpvim.org mpypl.org
  `.trim().split(/\s+/);
  
  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;

  const HOST_REWRITE_RE = /https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi;
  
  
  const serverCache = new Map();
  const failedCache = new Map();

  const swarmHostMap = new Map();
  const swarmLeaderPromises = new Map();

  let mpFamilyWinnerTuple = null;
  let mpFamilyWaiters = [];

  const persistentHostMeta = new Map();
  const persistentUrlMeta = new Map();
  let persistTimer = null;
  
  
  const processingImages = new WeakSet();
  const pendingImages = new Set();
  let pendingFlushTimer = null;

  function nowMs() {
    return Date.now();
  }

  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function pruneMetaMap(metaMap, maxEntries) {
    if (metaMap.size <= maxEntries) return;
    const entries = Array.from(metaMap.entries());
    entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    const toRemove = entries.slice(0, Math.max(0, metaMap.size - maxEntries));
    for (const [k] of toRemove) metaMap.delete(k);
  }

  function persistNow() {
    try {
      pruneMetaMap(persistentHostMeta, HOST_CACHE_MAX);
      pruneMetaMap(persistentUrlMeta, URL_CACHE_MAX);

      const hostsObj = {};
      for (const [badBase, meta] of persistentHostMeta.entries()) {
        hostsObj[badBase] = { host: meta.host, lastUsed: meta.lastUsed || 0 };
      }

      const urlsObj = {};
      for (const [badUrl, meta] of persistentUrlMeta.entries()) {
        urlsObj[badUrl] = { fixedUrl: meta.fixedUrl, lastUsed: meta.lastUsed || 0 };
      }

      const payload = {
        version: CACHE_VERSION,
        savedAt: nowMs(),
        hosts: hostsObj,
        urls: urlsObj
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
    }
  }

  function schedulePersist() {
    try {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistNow();
      }, PERSIST_DEBOUNCE_DELAY);
    } catch {
    }
  }

  function hostBaseFromUrl(url) {
    return String(url).split('/').slice(0, 3).join('/');
  }

  function getMpFamilyWinner() {
    return mpFamilyWinnerTuple;
  }

  function setMpFamilyWinner(tuple) {
    if (!tuple || typeof tuple.prefix !== 'string') return;
    if (typeof tuple.number !== 'number') return;
    if (typeof tuple.root !== 'string') return;
    if (typeof tuple.tld !== 'string') return;
    if (mpFamilyWinnerTuple) return;
    mpFamilyWinnerTuple = tuple;
    const waiters = mpFamilyWaiters;
    mpFamilyWaiters = [];
    for (const w of waiters) {
      try {
        if (!w.cancelled) w.resolve(tuple);
      } catch {
      }
    }
  }

  function waitMpFamilyWinner() {
    if (mpFamilyWinnerTuple) {
      return { promise: Promise.resolve(mpFamilyWinnerTuple), cancel: () => {} };
    }
    const entry = { cancelled: false, resolve: null };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    mpFamilyWaiters.push(entry);
    const cancel = () => {
      entry.cancelled = true;
    };
    return { promise, cancel };
  }

  function isTemporarilyFailedHost(cacheKey) {
    const until = failedCache.get(cacheKey);
    if (!until) return false;
    if (until <= nowMs()) {
      failedCache.delete(cacheKey);
      return false;
    }
    return true;
  }

  function markHostFailed(cacheKey, reason) {
    const now = nowMs();
    const backoffMs = reason === 'timeout' ? 15000 : 120000;
    const until = now + backoffMs;
    const prev = failedCache.get(cacheKey) || 0;
    failedCache.set(cacheKey, Math.max(prev, until));
  }

  function loadPersistentCache() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed.version !== 'number') return;
      if (![1, 2, 3].includes(parsed.version)) return;

      const hosts = parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {};
      const urls = parsed.urls && typeof parsed.urls === 'object' ? parsed.urls : {};

      for (const [badBase, entry] of Object.entries(hosts)) {
        if (!entry || typeof entry !== 'object') continue;
        const host = entry.host;
        if (!host || typeof host !== 'object') continue;
        if (typeof host.prefix !== 'string') continue;
        if (typeof host.number !== 'number') continue;
        if (typeof host.root !== 'string') continue;
        if (typeof host.tld !== 'string') continue;
        const lastUsed = typeof entry.lastUsed === 'number' ? entry.lastUsed : 0;

        persistentHostMeta.set(badBase, { host, lastUsed });
        swarmHostMap.set(badBase, host);
      }

      for (const [badUrl, entry] of Object.entries(urls)) {
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.fixedUrl !== 'string') continue;
        const lastUsed = typeof entry.lastUsed === 'number' ? entry.lastUsed : 0;
        persistentUrlMeta.set(badUrl, { fixedUrl: entry.fixedUrl, lastUsed });
      }

      if (parsed.version === 1) {
        for (const [badUrl, entry] of Object.entries(urls)) {
          if (!entry || typeof entry !== 'object') continue;
          if (typeof entry.fixedUrl !== 'string') continue;
          const lastUsed = typeof entry.lastUsed === 'number' ? entry.lastUsed : 0;

          const badParsed = parseSubdomain(badUrl);
          const fixedParsed = parseSubdomain(entry.fixedUrl);
          if (!badParsed || !fixedParsed) continue;

          const badBase = toBase(badParsed);
          const tuple = toHostTuple(fixedParsed);
          const prev = persistentHostMeta.get(badBase);
          if (prev) {
            if ((prev.lastUsed || 0) < lastUsed) prev.lastUsed = lastUsed;
          } else {
            persistentHostMeta.set(badBase, { host: tuple, lastUsed });
          }
          swarmHostMap.set(badBase, tuple);
        }
      }

      if (parsed.version !== CACHE_VERSION) schedulePersist();
    } catch (e) {
    }
  }

  function ensurePersistentCacheKey() {
    try {
      if (localStorage.getItem(STORAGE_KEY) != null) return;
      const payload = {
        version: CACHE_VERSION,
        savedAt: nowMs(),
        hosts: {},
        urls: {}
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
    }
  }

  function enqueueImage(img) {
    if (!img || img.tagName !== 'IMG' || !img.src) return;
    if (pendingImages.has(img)) return;
    pendingImages.add(img);
    if (pendingFlushTimer) return;
    pendingFlushTimer = setTimeout(() => {
      pendingFlushTimer = null;
      const batch = Array.from(pendingImages);
      pendingImages.clear();
      for (const queuedImg of batch) {
        processNewImage(queuedImg);
        setTimeout(() => checkImage(queuedImg), CHECK_DELAY);
      }
    }, 50);
  }

  function parseSubdomain(src) {
    const m = src.match(SUBDOMAIN_RE);
    if (!m) return null;
    return {
      prefix: m[1].toLowerCase(),
      number: parseInt(m[2], 10),
      root: m[3].toLowerCase(),
      tld: m[4].toLowerCase(),
      path: m[5]
    };
  }

  function toBase(parsed) {
    return `https://${parsed.prefix}${String(parsed.number).padStart(2, '0')}.${parsed.root}.${parsed.tld}`;
  }

  function toHostTuple(parsed) {
    return {
      prefix: parsed.prefix,
      number: parsed.number,
      root: parsed.root,
      tld: parsed.tld
    };
  }

  function isHostTuple(obj) {
    return !!obj && typeof obj === 'object'
      && typeof obj.prefix === 'string'
      && typeof obj.number === 'number'
      && typeof obj.root === 'string'
      && typeof obj.tld === 'string';
  }

  function pathKeyOf(parsed) {
    try {
      return parsed.path.split('/').slice(0, 3).join('/');
    } catch {
      return '';
    }
  }

  function serverCacheKey(parsed) {
    return `${parsed.root}-${pathKeyOf(parsed)}`;
  }

  function tupleBase(tuple) {
    return `https://${tuple.prefix}${String(tuple.number).padStart(2, '0')}.${tuple.root}.${tuple.tld}`;
  }

  function rememberOriginal(img, force = false) {
    if (!img || !img.dataset) return;
    if (force || !img.dataset.originalSrc) img.dataset.originalSrc = img.src;
    if (img.srcset && (force || !img.dataset.originalSrcset)) img.dataset.originalSrcset = img.srcset;
  }

  function restoreOriginal(img) {
    if (!img || !img.dataset || !img.dataset.originalSrc) return false;
    img.src = img.dataset.originalSrc;
    if (img.dataset.originalSrcset) img.srcset = img.dataset.originalSrcset;
    return true;
  }

  function applyUrlAndSrcset(img, newUrl, newBase) {
    img.referrerPolicy = 'no-referrer';
    img.src = newUrl;
    if (img.srcset) {
      const newSrcset = rewriteSrcsetToBase(img.srcset, newBase);
      if (newSrcset) img.srcset = newSrcset;
    }
  }

  function commitPreemptiveDatasetWin(img, hostJson, badBase) {
    try {
      const tuple = safeJsonParse(hostJson);
      if (!isHostTuple(tuple)) return null;

      swarmHostMap.set(badBase, tuple);
      const meta = persistentHostMeta.get(badBase);
      if (meta) {
        meta.host = tuple;
        meta.lastUsed = nowMs();
      } else {
        persistentHostMeta.set(badBase, { host: tuple, lastUsed: nowMs() });
      }

      if (img.dataset.originalSrc) {
        persistentUrlMeta.set(img.dataset.originalSrc, { fixedUrl: img.src, lastUsed: nowMs() });
      }
      schedulePersist();
      return tuple;
    } catch {
      return null;
    }
  }

  function isMpRootLabel(rootLabel) {
    return typeof rootLabel === 'string' && rootLabel.startsWith('mp');
  }

  function rootEntry(str) {
    const parts = String(str).split('.');
    if (parts.length < 2) return null;
    return { root: parts.slice(0, -1).join('.').toLowerCase(), tld: parts[parts.length - 1].toLowerCase() };
  }

  const ALL_ROOT_ENTRIES = ALL_ROOTS.map(rootEntry).filter(Boolean);

  function getPrefixOrder(parsed) {
    const primary = isMpRootLabel(parsed.root) ? PREFIX_PRIORITY_MP : PREFIX_PRIORITY_MB;
    const seen = new Set();
    const order = [];
    for (const p of [...primary, ...EXTRA_PREFIXES]) {
      if (!seen.has(p)) {
        seen.add(p);
        order.push(p);
      }
    }
    return order;
  }

  function getNumberOrder(parsed) {
    const order = [];
    const seen = new Set();
    const addNum = (n) => {
      if (n < 0 || n > MAX_SERVER_NUM) return;
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    };

    addNum(parsed.number);
    const preferred = isMpRootLabel(parsed.root) ? PREFERRED_NUM_ORDER_MP : PREFERRED_NUM_ORDER_MB;
    for (const n of preferred) addNum(n);
    for (let n = 0; n <= MAX_SERVER_NUM; n++) addNum(n);
    return order;
  }

  function getRootOrder(parsed) {
    const priorityList = isMpRootLabel(parsed.root) ? ROOT_PRIORITY_MP : ROOT_PRIORITY_MB;

    const priorityEntries = priorityList
      .map(rootEntry)
      .filter(Boolean)
      .filter(r => !(r.root === parsed.root && r.tld === parsed.tld));

    const prioritySet = new Set(priorityEntries.map(r => `${r.root}.${r.tld}`));
    const rest = ALL_ROOT_ENTRIES
      .filter(r => !(r.root === parsed.root && r.tld === parsed.tld))
      .filter(r => !prioritySet.has(`${r.root}.${r.tld}`));

    return [
      { root: parsed.root, tld: parsed.tld },
      ...priorityEntries,
      ...rest
    ];
  }

  function probeUrl(url, timeout = PROBE_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const cacheKey = hostBaseFromUrl(url);
      if (isTemporarilyFailedHost(cacheKey)) {
        reject('cached-fail');
        return;
      }
      
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      try {
        img.decoding = 'async';
        img.fetchPriority = 'low';
      } catch {
      }
      
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        try {
          img.onload = null;
          img.onerror = null;
          img.src = 'data:,';
        } catch {
        }
        markHostFailed(cacheKey, 'timeout');
        reject('timeout');
      }, timeout);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(t);
          if (img.width > 1 || img.height > 1) {
            resolve(true);
          } else {
            markHostFailed(cacheKey, 'empty');
            reject('empty');
          }
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(t);
          markHostFailed(cacheKey, 'error');
          reject('error');
        }
      };
      
      img.src = url;
    });
  }

  function probeUrlCancelable(url, timeout = PROBE_TIMEOUT) {
    const cacheKey = hostBaseFromUrl(url);
    if (isTemporarilyFailedHost(cacheKey)) {
      return { promise: Promise.reject('cached-fail'), cancel: () => {} };
    }

    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    try {
      img.decoding = 'async';
      img.fetchPriority = 'low';
    } catch {
    }
    let settled = false;
    let timedOut = false;
    let t = null;

    const promise = new Promise((resolve, reject) => {
      t = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        settled = true;
        try {
          img.onload = null;
          img.onerror = null;
          img.src = 'data:,';
        } catch {
        }
        markHostFailed(cacheKey, 'timeout');
        reject('timeout');
      }, timeout);

      img.onload = () => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(t);
        if (img.width > 1 || img.height > 1) resolve(true);
        else {
          markHostFailed(cacheKey, 'empty');
          reject('empty');
        }
      };

      img.onerror = () => {
        if (settled || timedOut) return;
        settled = true;
        clearTimeout(t);
        markHostFailed(cacheKey, 'error');
        reject('error');
      };

      img.src = url;
    });

    const cancel = () => {
      if (settled) return;
      settled = true;
      try { if (t) clearTimeout(t); } catch { }
      try {
        img.onload = null;
        img.onerror = null;
        img.src = 'data:,';
      } catch { }
    };

    return { promise, cancel };
  }

  function promiseAny(promises) {
    return new Promise((resolve, reject) => {
      if (!promises || promises.length === 0) {
        reject('empty');
        return;
      }
      let rejected = 0;
      let lastErr = null;
      for (const p of promises) {
        Promise.resolve(p).then(resolve).catch((e) => {
          lastErr = e;
          rejected++;
          if (rejected === promises.length) reject(lastErr || 'failed');
        });
      }
    });
  }

  function generateCandidates(parsed) {
    const candidates = [];

    const add = (p, n, r, t) => {
      candidates.push(`https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`);
    };

    const badBase = toBase(parsed);
    if (swarmHostMap.has(badBase)) {
      const h = swarmHostMap.get(badBase);
      add(h.prefix, h.number, h.root, h.tld);
      return candidates;
    }

    const cacheKey = serverCacheKey(parsed);
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      add(cached.prefix, cached.number, cached.root, cached.tld);
    }

    const prefixOrder = getPrefixOrder(parsed);
    const numberOrder = getNumberOrder(parsed);
    const rootOrder = getRootOrder(parsed);
    const originalRoot = { root: parsed.root, tld: parsed.tld };
    const isMp = isMpRootLabel(parsed.root);

    const topPrefixes = prefixOrder.slice(0, 4);
    const topNumbers = numberOrder.slice(0, 6);

    const addIfRoom = (p, n, r, t) => {
      if (candidates.length >= MAX_ATTEMPTS) return false;
      add(p, n, r, t);
      return true;
    };

    const quotaPrefixSwap = 8;
    const quotaNumberSwap = 8;
    const quotaSameRootCombo = 8;
    const quotaRootBridge = 12;
    const quotaRootGeneric = 12;

    let used = 0;
    for (const p of prefixOrder) {
      if (used >= quotaPrefixSwap) break;
      if (p === parsed.prefix) continue;
      if (!addIfRoom(p, parsed.number, originalRoot.root, originalRoot.tld)) break;
      used++;
    }

    used = 0;
    for (const n of numberOrder) {
      if (used >= quotaNumberSwap) break;
      if (n === parsed.number) continue;
      if (!addIfRoom(parsed.prefix, n, originalRoot.root, originalRoot.tld)) break;
      used++;
    }

    if (isMp) {
      const mbRoots = rootOrder.filter(r => r.root.startsWith('mb') && !(r.root === originalRoot.root && r.tld === originalRoot.tld));
      const mbRootsTop = mbRoots.slice(0, 6);
      const bridgePrefixes = ['n', 'b', 'd', 's'];

      used = 0;
      for (const r of mbRootsTop) {
        for (const p of bridgePrefixes) {
          for (const n of topNumbers) {
            if (used >= quotaRootBridge) break;
            if (!addIfRoom(p, n, r.root, r.tld)) break;
            used++;
          }
          if (used >= quotaRootBridge || candidates.length >= MAX_ATTEMPTS) break;
        }
        if (used >= quotaRootBridge || candidates.length >= MAX_ATTEMPTS) break;
      }
    }

    used = 0;
    for (const p of topPrefixes) {
      for (const n of topNumbers) {
        if (used >= quotaSameRootCombo) break;
        if (p === parsed.prefix && n === parsed.number) continue;
        if (!addIfRoom(p, n, originalRoot.root, originalRoot.tld)) break;
        used++;
      }
      if (used >= quotaSameRootCombo || candidates.length >= MAX_ATTEMPTS) break;
    }

    used = 0;
    let rootsAdded = 0;
    const rootLimit = 10;
    for (const r of rootOrder) {
      if (used >= quotaRootGeneric) break;
      if (candidates.length >= MAX_ATTEMPTS) break;
      if (r.root === originalRoot.root && r.tld === originalRoot.tld) continue;
      rootsAdded++;
      if (rootsAdded > rootLimit) break;

      for (const p of topPrefixes) {
        if (used >= quotaRootGeneric) break;
        for (const n of topNumbers.slice(0, 2)) {
          if (used >= quotaRootGeneric) break;
          if (!addIfRoom(p, n, r.root, r.tld)) break;
          used++;
        }
        if (candidates.length >= MAX_ATTEMPTS) break;
      }
    }

    const seen = new Set();
    const out = [];
    for (const url of candidates) {
      if (!seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
      if (out.length >= MAX_ATTEMPTS) break;
    }

    return out;
  }

  function rewriteSrcsetToBase(srcset, newBase) {
    if (!srcset || !newBase) return null;
    return srcset.replace(HOST_REWRITE_RE, newBase);
  }

  function applyMpFamilyPreemptive(img, hostTuple, parsed, badBase) {
    if (!img || !hostTuple || !parsed || !badBase) return false;
    if (img.dataset.batoMpFamilyPreemptive === 'true') return true;
    if (img.dataset.batoPreemptive === 'true') return false;

    const newBase = tupleBase(hostTuple);
    const newUrl = `${newBase}${parsed.path}`;

    rememberOriginal(img);

    img.dataset.batoMpFamilyBadBase = badBase;
    if (!img.dataset.batoMpFamilyHost) {
      img.dataset.batoMpFamilyHost = JSON.stringify({
        prefix: hostTuple.prefix,
        number: hostTuple.number,
        root: hostTuple.root,
        tld: hostTuple.tld
      });
    }

    applyUrlAndSrcset(img, newUrl, newBase);

    img.dataset.batoMpFamilyPreemptive = 'true';
    setTimeout(() => checkImage(img), K_PREEMPTIVE_VERIFY_DELAY);
    return true;
  }

  function broadcastMpFamilyPreemptive(hostTuple) {
    const hostJson = JSON.stringify({
      prefix: hostTuple.prefix,
      number: hostTuple.number,
      root: hostTuple.root,
      tld: hostTuple.tld
    });
    document.querySelectorAll('img').forEach(img => {
      if (!img || img.tagName !== 'IMG' || !img.src) return;
      if (img.dataset.batoFixed === 'true') return;
      if (img.dataset.batoMpFamilyPreemptive === 'true') return;
      if (img.dataset.batoPreemptive === 'true') return;

      const p = parseSubdomain(img.src);
      if (!p) return;
      if (!isMpRootLabel(p.root)) return;

      const badBase = toBase(p);
      if (swarmHostMap.has(badBase)) return;

      img.dataset.batoMpFamilyHost = hostJson;

      applyMpFamilyPreemptive(img, hostTuple, p, badBase);
    });
  }

  
  function applyHostToImage(img, hostTuple, originalParsed = null) {
    const parsed = originalParsed || parseSubdomain(img.src);
    if (!parsed) return;

    const oldUrl = img.src;
    const newBase = tupleBase(hostTuple);
    const newUrl = `${newBase}${parsed.path}`;
    try {
      const badBase = toBase(parsed);
      swarmHostMap.set(badBase, hostTuple);
      const meta = persistentHostMeta.get(badBase);
      if (meta) {
        meta.host = hostTuple;
        meta.lastUsed = nowMs();
      } else {
        persistentHostMeta.set(badBase, { host: hostTuple, lastUsed: nowMs() });
      }

      persistentUrlMeta.set(oldUrl, { fixedUrl: newUrl, lastUsed: nowMs() });
      schedulePersist();
    } catch {
    }
    applyUrlAndSrcset(img, newUrl, newBase);
  }

  function applyKnownSwarmFixIfAny(img, parsed = null) {
    if (img && img.dataset && img.dataset.batoFixed === 'true') return false;
    const p = parsed || parseSubdomain(img.src);
    if (!p) return false;
    const badBase = toBase(p);
    const known = swarmHostMap.get(badBase);
    if (!known) return false;

    rememberOriginal(img);

    img.dataset.batoSwarmPreemptive = 'true';
    img.dataset.batoFixing = 'true';

    try {
      img.dataset.batoSwarmBadBase = badBase;
      img.dataset.batoSwarmHost = JSON.stringify({
        prefix: known.prefix,
        number: known.number,
        root: known.root,
        tld: known.tld
      });
    } catch {
    }

    const newBase = tupleBase(known);
    const newUrl = `${newBase}${p.path}`;
    applyUrlAndSrcset(img, newUrl, newBase);

    img.dataset.batoFixing = 'done';
    img.dataset.batoFixed = 'true';

    return true;
  }

  function applyExactUrlFixIfAny(img) {
    const meta = persistentUrlMeta.get(img.src);
    if (!meta || !meta.fixedUrl) return false;

    rememberOriginal(img);

    img.dataset.batoUrlPreemptive = 'true';
    img.dataset.batoFixing = 'true';

    const fixed = meta.fixedUrl;
    let fixedBase = null;
    try {
      fixedBase = new URL(fixed).origin;
    } catch {
    }
    applyUrlAndSrcset(img, fixed, fixedBase);

    img.dataset.batoFixing = 'done';
    img.dataset.batoFixed = 'true';

    meta.lastUsed = nowMs();
    schedulePersist();
    return true;
  }

  function broadcastSwarmFix(badBase, goodHostTuple) {
    const updated = [];
    const newBase = `https://${goodHostTuple.prefix}${String(goodHostTuple.number).padStart(2, '0')}.${goodHostTuple.root}.${goodHostTuple.tld}`;
    document.querySelectorAll('img').forEach(img => {
      const src = img && img.src;
      if (!src) return;
      if (!src.startsWith(badBase)) return;

      const p = parseSubdomain(src);
      if (!p) return;

      const oldUrl = src;
      const newUrl = `${newBase}${p.path}`;

      img.dataset.batoFixing = 'true';
      try {
        swarmHostMap.set(badBase, goodHostTuple);
        const meta = persistentHostMeta.get(badBase);
        if (meta) {
          meta.host = goodHostTuple;
          meta.lastUsed = nowMs();
        } else {
          persistentHostMeta.set(badBase, { host: goodHostTuple, lastUsed: nowMs() });
        }
        persistentUrlMeta.set(oldUrl, { fixedUrl: newUrl, lastUsed: nowMs() });
        schedulePersist();
      } catch {
      }

      img.src = newUrl;
      if (img.srcset) {
        const newSrcset = rewriteSrcsetToBase(img.srcset, newBase);
        if (newSrcset) img.srcset = newSrcset;
      }

      img.dataset.batoFixing = 'done';
      img.dataset.batoFixed = 'true';
      updated.push(img);
    });

    return updated;
  }

  async function leaderProbeAndSwarm(parsed) {
    const badBase = toBase(parsed);
    const preflightTuple = await tryBestFullHostsPreflight(parsed, 4);
    if (preflightTuple) {
      return commitSwarmWin(badBase, preflightTuple, parsed, true);
    }

    const candidates = generateCandidates(parsed);
    let lastError = null;

    if (isMpRootLabel(parsed.root)) {
      const family = getMpFamilyWinner();
      if (family) return family;

      const familyWait = waitMpFamilyWinner();
      let i = 0;
      const maxParallel = Math.min(PROBE_PARALLEL_TRIES, candidates.length);
      while (i < maxParallel) {
        const early = getMpFamilyWinner();
        if (early) {
          familyWait.cancel();
          return early;
        }

        const batch = [];
        const cancels = [];
        for (let j = 0; j < PROBE_PARALLEL && i + j < maxParallel; j++) {
          const url = candidates[i + j];
          const serverPattern = hostBaseFromUrl(url);
          if (isTemporarilyFailedHost(serverPattern)) continue;
          const timeout = PROBE_TIMEOUT + Math.min(4000, (i + j) * 250);
          const { promise, cancel } = probeUrlCancelable(url, timeout);
          cancels.push(cancel);
          batch.push(promise.then(() => url));
        }

        try {
          const okUrl = await Promise.race([
            promiseAny(batch),
            familyWait.promise.then(() => { throw 'family-win'; })
          ]);
          for (const c of cancels) c();

          const successParsed = parseSubdomain(okUrl);
          if (!successParsed) throw 'failed';

          const tuple = toHostTuple(successParsed);
          return commitSwarmWin(badBase, tuple, parsed);
        } catch (e) {
          lastError = e;
          for (const c of cancels) c();
          if (e === 'family-win') {
            const t = getMpFamilyWinner();
            if (t) {
              familyWait.cancel();
              return t;
            }
          }
        }

        i += PROBE_PARALLEL;
      }

      familyWait.cancel();
    }

    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];

      const serverPattern = hostBaseFromUrl(url);
      if (isTemporarilyFailedHost(serverPattern)) continue;

      try {
        const timeout = PROBE_TIMEOUT + Math.min(4000, i * 250);
        await probeUrl(url, timeout);

        const successParsed = parseSubdomain(url);
        if (!successParsed) continue;

        const tuple = toHostTuple(successParsed);
        return commitSwarmWin(badBase, tuple, parsed);
      } catch (e) {
        lastError = e;
        if (e === 'timeout' && i > 18) break;
      }
    }
    throw lastError || 'failed';
  }

  async function fixImage(img, isRetry = false) {
    if (processingImages.has(img)) return;
    
    if (img.dataset.batoFixing === "done" || 
        (img.dataset.batoFixing === "true" && !isRetry)) return;
    
    processingImages.add(img);
    img.dataset.batoFixing = "true";

    const parsed = parseSubdomain(img.src);
    if (!parsed) {
      img.dataset.batoFixing = '';
      processingImages.delete(img);
      return;
    }

    if (applyExactUrlFixIfAny(img)) {
      processingImages.delete(img);
      return;
    }

    const badBase = toBase(parsed);

    if (isMpRootLabel(parsed.root)) {
      const family = getMpFamilyWinner();
      if (family && !swarmHostMap.has(badBase)) {
        if (applyMpFamilyPreemptive(img, family, parsed, badBase)) {
          img.dataset.batoFixing = '';
          processingImages.delete(img);
          return;
        }
      }
    }

    if (swarmHostMap.has(badBase)) {
      applyHostToImage(img, swarmHostMap.get(badBase), parsed);
      img.dataset.batoFixing = 'done';
      img.dataset.batoFixed = 'true';
      processingImages.delete(img);
      return;
    }

    let leaderPromise = swarmLeaderPromises.get(badBase);
    if (!leaderPromise) {
      leaderPromise = (async () => {
        try {
          return await leaderProbeAndSwarm(parsed);
        } finally {
          swarmLeaderPromises.delete(badBase);
        }
      })();
      swarmLeaderPromises.set(badBase, leaderPromise);
    }

    let lastError = null;
    try {
      const tuple = await leaderPromise;
      applyHostToImage(img, tuple, parsed);
      img.dataset.batoFixing = 'done';
      img.dataset.batoFixed = 'true';
      processingImages.delete(img);

      return;
    } catch (e) {
      lastError = e;
    }
    
    if (!isRetry && lastError === 'timeout') {
      img.dataset.batoFixing = "retry";
      processingImages.delete(img);
      
      setTimeout(() => {
        if (img.complete && img.naturalWidth === 0) {
          fixImage(img, true);
        }
      }, RETRY_DELAY);
    } else {
      img.dataset.batoFixing = "failed";
      processingImages.delete(img);
    }
  }

  function preemptiveFix(img) {
    const parsed = parseSubdomain(img.src);
    if (!parsed) return false;
    
    if (parsed.prefix !== 'k') return false;
    
    const cacheKey = serverCacheKey(parsed);
    
    let newPrefix = 'n';
    let newNumber = parsed.number;
    let newRoot = parsed.root;
    let newTld = parsed.tld;
    
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      newPrefix = cached.prefix;
      newNumber = cached.number;
      newRoot = cached.root;
      newTld = cached.tld;
    }

    const newBase = `https://${newPrefix}${String(newNumber).padStart(2, '0')}.${newRoot}.${newTld}`;
    const newUrl = `${newBase}${parsed.path}`;
    
    rememberOriginal(img, true);
    img.dataset.batoPreemptiveBadBase = toBase(parsed);
    img.dataset.batoPreemptiveHost = JSON.stringify({ prefix: newPrefix, number: newNumber, root: newRoot, tld: newTld });
    applyUrlAndSrcset(img, newUrl, newBase);
    
    img.dataset.batoPreemptive = "true";
    return true;
  }

  function checkImage(img) {
    if (img.dataset.batoUrlPreemptive === 'true' && img.complete && img.naturalWidth === 0) {
      try {
        if (img.dataset.originalSrc) {
          persistentUrlMeta.delete(img.dataset.originalSrc);
          schedulePersist();
        }
      } catch {
      }
      restoreOriginal(img);
      img.dataset.batoUrlPreemptive = 'failed';
      img.dataset.batoFixing = '';
      fixImage(img);
      return;
    }

    if (img.dataset.batoSwarmPreemptive === 'true' && img.complete && img.naturalWidth > 0 && img.dataset.batoSwarmHost && img.dataset.batoSwarmBadBase) {
      commitPreemptiveDatasetWin(img, img.dataset.batoSwarmHost, img.dataset.batoSwarmBadBase);
      img.dataset.batoSwarmPreemptive = 'done';
      img.dataset.batoSwarmHost = '';
      img.dataset.batoSwarmBadBase = '';
      return;
    }

    if (img.dataset.batoSwarmPreemptive === 'true' && img.complete && img.naturalWidth === 0) {
      try {
        const badBase = img.dataset.batoSwarmBadBase;
        if (badBase) {
          swarmHostMap.delete(badBase);
          persistentHostMeta.delete(badBase);
        }
        if (img.dataset.originalSrc) {
          persistentUrlMeta.delete(img.dataset.originalSrc);
        }
        schedulePersist();
      } catch {
      }
      restoreOriginal(img);
      img.dataset.batoSwarmPreemptive = 'failed';
      img.dataset.batoSwarmHost = '';
      img.dataset.batoSwarmBadBase = '';
      img.dataset.batoFixing = '';
      fixImage(img);
      return;
    }

    if (img.dataset.batoMpFamilyPreemptive === 'true' && img.complete && img.naturalWidth > 0 && img.dataset.batoMpFamilyHost && img.dataset.batoMpFamilyBadBase) {
      commitPreemptiveDatasetWin(img, img.dataset.batoMpFamilyHost, img.dataset.batoMpFamilyBadBase);
      img.dataset.batoMpFamilyPreemptive = 'done';
      img.dataset.batoMpFamilyHost = '';
      img.dataset.batoMpFamilyBadBase = '';
      return;
    }

    if (img.dataset.batoMpFamilyPreemptive === 'true' && img.complete && img.naturalWidth === 0) {
      restoreOriginal(img);
      img.dataset.batoMpFamilyPreemptive = 'failed';
      img.dataset.batoMpFamilyHost = '';
      img.dataset.batoMpFamilyBadBase = '';
      fixImage(img);
      return;
    }

    if (img.dataset.batoPreemptive === "true" && img.complete && img.naturalWidth > 0 && img.dataset.batoPreemptiveHost && img.dataset.batoPreemptiveBadBase) {
      img.dataset.batoPreemptive = "done";
      img.dataset.batoPreemptiveHost = '';
      img.dataset.batoPreemptiveBadBase = '';
      return;
    }

    if (img.dataset.batoPreemptive === "true" && img.complete && img.naturalWidth === 0) {
      restoreOriginal(img);
      img.dataset.batoPreemptive = "failed";
      img.dataset.batoPreemptiveHost = '';
      img.dataset.batoPreemptiveBadBase = '';
      fixImage(img);
      return;
    }
    
    if (img.complete && img.naturalWidth === 0 && img.dataset.batoFixing !== "done") {
      fixImage(img);
    }
  }

  function processNewImage(img) {
    if (!img || img.tagName !== 'IMG' || !img.src) return;

    if (img.dataset.batoListenerAttached !== '1') {
      img.dataset.batoListenerAttached = '1';
      img.addEventListener('error', function() {
        setTimeout(() => {
          if (img.dataset.batoFixing !== "done") {
            fixImage(img);
          }
        }, ERROR_EVENT_DEBOUNCE);
      }, { once: false });
    }

    const parsed = parseSubdomain(img.src);

    if (parsed && parsed.prefix === 'k') {
      const badBase = toBase(parsed);
      const hasExact = persistentUrlMeta.has(img.src);
      const hasCdn = swarmHostMap.has(badBase);
      if (!hasExact && !hasCdn && preemptiveFix(img)) {
        setTimeout(() => checkImage(img), K_PREEMPTIVE_VERIFY_DELAY);
        return;
      }
    }

    if (applyExactUrlFixIfAny(img)) return;

    if (applyKnownSwarmFixIfAny(img, parsed)) return;

    // If it's still loading after a short delay, try a fast BEST_FULL_HOSTS preflight
    // without waiting for the actual error event.
    scheduleSlowLoadBestHostPreflight(img, parsed);
  }

  function init() {
    ensurePersistentCacheKey();
    loadPersistentCache();
    loadBestHostStats();
    document.querySelectorAll('img').forEach(enqueueImage);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IMG') {
            enqueueImage(node);
          }
          
          if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => {
              if (!img.dataset.batoFixing) {
                enqueueImage(img);
              }
            });
          }
        });
        
        if (mutation.type === 'attributes' && 
            (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') && 
            mutation.target.tagName === 'IMG') {
          
          const img = mutation.target;
          if (img.dataset.batoFixing !== "done" && !img.dataset.batoFixed) {
            img.dataset.batoFixing = "";
            img.dataset.batoPreemptive = "";
            img.dataset.batoSwarmPreemptive = "";
            setTimeout(() => {
              enqueueImage(img);
            }, ATTR_CHANGE_RESCAN_DELAY);
          }
        }
      });
    });

    observer.observe(document.body, { 
      childList: true, 
      subtree: true, 
      attributes: true, 
      attributeFilter: ['src', 'srcset'] 
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
