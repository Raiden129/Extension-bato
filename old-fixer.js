(() => {
  
  // Configuration
  const PROBE_TIMEOUT = 5000; 
  const MAX_ATTEMPTS = 30;
  const MAX_SERVER_NUM = 15;
  const RETRY_DELAY = 1000; 

  const PREFIX_PRIORITY = ['n', 's', 'b', 'd'];
  const EXTRA_PREFIXES = ['x', 't', 'w', 'm', 'c', 'u', 'k'];

  const PREFERRED_NUM_ORDER = [1, 0, 9, 2, 8, 7, 5, 4, 3, 10, 6, 11, 12, 15, 14, 13];

  const ROOT_PRIORITY = [
    'mbqgu.org', 'mbwbm.org', 'mbrtz.org', 'mbdny.org', 'mbopg.org', 'mbwnp.org',
    'mbznp.org', 'mbfpu.org', 'mbmyj.org', 'mbwww.org', 'mbzcp.org', 'mbtmv.org',
    'mbhiz.org', 'mbuul.org', 'mbxma.org', 'mbeaj.org', 'mbimg.org',
    'mbtba.org',
    'bato.to'
  ];
  
  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;
  
  
  const serverCache = new Map();
  const failedCache = new Set(); 
  
  
  const processingImages = new WeakSet();

  function markInternalChange(img) {
    try {
      img.dataset.batoInternalChange = "1";
      setTimeout(() => {
        try { delete img.dataset.batoInternalChange; } catch { }
      }, 0);
    } catch {
    }
  }

  // 1. Parse URL
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

  // 2. Probe a URL 
  function probeUrl(url, timeout = PROBE_TIMEOUT) {
    return new Promise((resolve, reject) => {
      // Check failed cache first
      const cacheKey = url.split('/').slice(0, 3).join('/');
      if (failedCache.has(cacheKey)) {
        reject('cached-fail');
        return;
      }
      
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        try {
          img.onload = null;
          img.onerror = null;
          img.src = 'data:,';
        } catch {
        }
        failedCache.add(cacheKey);
        reject('timeout');
      }, timeout);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(t);
          if (img.width > 1 || img.height > 1) {
            resolve(true);
          } else {
            failedCache.add(cacheKey);
            reject('empty');
          }
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(t);
          failedCache.add(cacheKey);
          reject('error');
        }
      };
      
      img.src = url;
    });
  }

  function rootEntry(str) {
    const parts = String(str).split('.');
    if (parts.length < 2) return null;
    return { root: parts.slice(0, -1).join('.').toLowerCase(), tld: parts[parts.length - 1].toLowerCase() };
  }

  const ROOT_ENTRIES = ROOT_PRIORITY.map(rootEntry).filter(Boolean);

  function exactCacheKey(parsed) {
    return `${parsed.prefix}${String(parsed.number).padStart(2, '0')}.${parsed.root}.${parsed.tld}${parsed.path}`;
  }

  function getPrefixOrder(parsed) {
    const seen = new Set();
    const out = [];
    for (const p of [...PREFIX_PRIORITY, ...EXTRA_PREFIXES]) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }

  function getNumberOrder(parsed) {
    const seen = new Set();
    const out = [];
    const add = (n) => {
      if (n < 0 || n > MAX_SERVER_NUM) return;
      if (seen.has(n)) return;
      seen.add(n);
      out.push(n);
    };

    add(parsed.number);
    for (const n of PREFERRED_NUM_ORDER) add(n);
    for (let n = 0; n <= MAX_SERVER_NUM; n++) add(n);
    return out;
  }

  function getRootOrder(parsed) {
    const current = { root: parsed.root, tld: parsed.tld };
    const rest = ROOT_ENTRIES.filter(r => !(r.root === current.root && r.tld === current.tld));
    return [current, ...rest];
  }

  // 3. Generate candidate URLs (old probing style, improved heuristic ordering)
  function generateCandidates(parsed) {
    const candidates = [];
    const seen = new Set();

    const add = (p, n, r, t) => {
      const url = `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`;
      if (seen.has(url)) return;
      seen.add(url);
      candidates.push(url);
    };

    const cacheKey = exactCacheKey(parsed);
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      add(cached.prefix, cached.number, cached.root, cached.tld);
    }

    if (parsed.prefix === 'k') {
      add('n', parsed.number, parsed.root, parsed.tld);
      add('x', parsed.number, parsed.root, parsed.tld);
      add('t', parsed.number, parsed.root, parsed.tld);
    }

    const prefixOrder = getPrefixOrder(parsed);
    const numberOrder = getNumberOrder(parsed);
    const rootOrder = getRootOrder(parsed);
    const originalRoot = { root: parsed.root, tld: parsed.tld };

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

    return candidates.slice(0, MAX_ATTEMPTS);
  }

  // 4. Rewrite srcset attributes
  function rewriteSrcset(srcset, workingUrl) {
    if (!srcset) return null;
    
    const workingParsed = parseSubdomain(workingUrl);
    if (!workingParsed) return null;
    
    const newBase = `https://${workingParsed.prefix}${String(workingParsed.number).padStart(2, '0')}.${workingParsed.root}.${workingParsed.tld}`;
    
    return srcset.replace(/https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi, newBase);
  }

  
  async function fixImage(img, isRetry = false) {
    // Skip if already being processed
    if (processingImages.has(img)) return;
    
    // Check if already fixed or being fixed
    if (img.dataset.batoFixing === "done" || 
        (img.dataset.batoFixing === "true" && !isRetry)) return;
    
    processingImages.add(img);
    img.dataset.batoFixing = "true";

    const parsed = parseSubdomain(img.src);
    if (!parsed) {
      processingImages.delete(img);
      return;
    }

    const candidates = generateCandidates(parsed);
    let lastError = null;

    
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      
      // Skip if we already know this server pattern fails
      const serverPattern = url.split('/').slice(0, 3).join('/');
      if (failedCache.has(serverPattern)) continue;
      
      try {
        
        const timeout = PROBE_TIMEOUT + (i > 5 ? 1000 : 0);
        await probeUrl(url, timeout);
        
        //Cache the working server pattern
        const successParsed = parseSubdomain(url);
        if (successParsed) {
          const cacheKey = exactCacheKey(parsed);
          serverCache.set(cacheKey, {
            prefix: successParsed.prefix,
            number: successParsed.number,
            root: successParsed.root,
            tld: successParsed.tld
          });
        }
        
        // Apply the fix
        markInternalChange(img);
        img.referrerPolicy = "no-referrer";
        img.src = url;
        
        // Update srcset if it exists
        if (img.srcset) {
          markInternalChange(img);
          const newSrcset = rewriteSrcset(img.srcset, url);
          if (newSrcset) img.srcset = newSrcset;
        }

        img.dataset.batoFixing = "done";
        img.dataset.batoFixed = "true";
        processingImages.delete(img);
        return;
        
      } catch (e) {
        lastError = e;
        if (e === 'timeout' && i > 10) {
          break;
        }
      }
    }
    
    // 
    if (!isRetry && lastError === 'timeout') {
      img.dataset.batoFixing = "retry";
      processingImages.delete(img);
      
      setTimeout(() => {
        // Check if image is still broken before retrying
        if (img.complete && img.naturalWidth === 0) {
          fixImage(img, true);
        }
      }, RETRY_DELAY);
    } else {
      img.dataset.batoFixing = "failed";
      processingImages.delete(img);
    }
  }

  // 6. Quick preemptive fix for known problematic servers
  function preemptiveFix(img) {
    const parsed = parseSubdomain(img.src);
    if (!parsed) return false;
    
    // Only preemptively fix k servers (most common issue)
    if (parsed.prefix !== 'k') return false;
    
    // Preemptive swap should be deterministic: ONLY do k→n here.
    // Cache is reserved for brute-force fixes.
    const newPrefix = 'n';
    const newNumber = parsed.number;
    const newRoot = parsed.root;
    const newTld = parsed.tld;
    
    const newUrl = `https://${newPrefix}${String(newNumber).padStart(2, '0')}.${newRoot}.${newTld}${parsed.path}`;
    
    img.dataset.originalSrc = img.src;
    markInternalChange(img);
    img.referrerPolicy = "no-referrer";
    img.src = newUrl;
    
    if (img.srcset) {
      img.dataset.originalSrcset = img.srcset;
      markInternalChange(img);
      const newSrcset = rewriteSrcset(img.srcset, newUrl);
      if (newSrcset) img.srcset = newSrcset;
    }
    
    img.dataset.batoPreemptive = "true";
    return true;
  }

  // 7. Check if image needs fixing
  function checkImage(img) {
    // For images that were preemptively fixed, verify they loaded
    if (img.dataset.batoPreemptive === "true" && img.complete && img.naturalWidth === 0) {
      // Preemptive fix failed, restore original and try full fix
      if (img.dataset.originalSrc) {
        markInternalChange(img);
        img.src = img.dataset.originalSrc;
        if (img.dataset.originalSrcset) {
          markInternalChange(img);
          img.srcset = img.dataset.originalSrcset;
        }
      }
      img.dataset.batoPreemptive = "failed";
      fixImage(img);
      return;
    }
    
    // Check if image is broken
    if (img.complete && img.naturalWidth === 0 && img.dataset.batoFixing !== "done") {
      fixImage(img);
    }
  }

  // 8. Process new image
  function processNewImage(img) {
    // Try preemptive fix for k servers
    const parsed = parseSubdomain(img.src);
    if (parsed && parsed.prefix === 'k') {
      preemptiveFix(img);
      
      // Verify after a short delay
      setTimeout(() => checkImage(img), 2000);
    }
    
    // Add error handler (only once per element)
    if (img.dataset.batoHasErrorListener !== "true") {
      img.dataset.batoHasErrorListener = "true";
      img.addEventListener('error', function() {
        // Small delay to prevent race conditions
        setTimeout(() => {
          if (img.dataset.batoFixing !== "done") {
            fixImage(img);
          }
        }, 100);
      });
    }
  }

  // 9. Initialize
  function init() {
    // Process all existing images
    document.querySelectorAll('img').forEach(img => {
      processNewImage(img);
      // Check existing images after a delay
      setTimeout(() => checkImage(img), 1000);
    });

    // Watch for new images and changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        // Handle added nodes
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IMG') {
            processNewImage(node);
            setTimeout(() => checkImage(node), 1000);
          }
          
          if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => {
              if (!img.dataset.batoFixing) {
                processNewImage(img);
                setTimeout(() => checkImage(img), 1000);
              }
            });
          }
        });
        
        // Handle src/srcset changes
        if (mutation.type === 'attributes' && 
            (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') && 
            mutation.target.tagName === 'IMG') {
          
          const img = mutation.target;
          // Ignore attribute changes we caused ourselves (preemptive swap / final fix / rollback)
          if (img.dataset && img.dataset.batoInternalChange === "1") {
            return;
          }
          // Reset fixing status if src changed and not by us
          if (img.dataset.batoFixing !== "done" && !img.dataset.batoFixed) {
            img.dataset.batoFixing = "";
            img.dataset.batoPreemptive = "";
            setTimeout(() => {
              processNewImage(img);
              checkImage(img);
            }, 500);
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

  // Start the extension
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
