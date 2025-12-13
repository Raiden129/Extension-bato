(() => {
  
  // Configuration
  const PROBE_TIMEOUT = 5000; 
  const MAX_ATTEMPTS = 30;
  const MAX_SERVER_NUM = 15;
  const RETRY_DELAY = 1000; 
  
  const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
  const FALLBACK_ROOTS = ['mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org'];
  
  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;
  
  
  const serverCache = new Map();
  const failedCache = new Set(); 
  
  
  const processingImages = new WeakSet();

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
        img.src = "";
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

  // 3. Generate candidate URLs with smart prioritization
  function generateCandidates(parsed) {
    const candidates = [];
    const pathKey = parsed.path.split('/').slice(0, 3).join('/'); 
    
    const add = (p, n, r, t, priority = 1) => {
      const url = `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`;
      candidates.push({ url, priority });
    };

    // Priority 0: Check cache for known working patterns
    const cacheKey = `${parsed.root}-${pathKey}`;
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      add(cached.prefix, cached.number, cached.root, cached.tld, 0);
    }

    // Priority 1: Quick k→n fix (most common issue)
    if (parsed.prefix === 'k') {
      add('n', parsed.number, parsed.root, parsed.tld, 1);
      add('x', parsed.number, parsed.root, parsed.tld, 1);
      add('t', parsed.number, parsed.root, parsed.tld, 1);
    }

    // Priority 2: Try other common prefixes
    FALLBACK_PREFIXES.forEach(letter => {
      if (letter !== parsed.prefix && letter !== 'k' && letter !== 'n') {
        add(letter, parsed.number, parsed.root, parsed.tld, 2);
      }
    });

    // Priority 3: Try same prefix with different numbers (for load balancing issues)
    for (let i = 0; i <= Math.min(5, MAX_SERVER_NUM); i++) {
      if (i !== parsed.number) {
        add(parsed.prefix, i, parsed.root, parsed.tld, 3);
      }
    }

    // Priority 4: Try different root domains
    FALLBACK_ROOTS.forEach(root => {
      const parts = root.split('.');
      if (parts.length === 2 && parts[0] !== parsed.root) {
        add(parsed.prefix, parsed.number, parts[0], parts[1], 4);
        // Also try n prefix with different roots
        if (parsed.prefix === 'k') {
          add('n', parsed.number, parts[0], parts[1], 4);
        }
      }
    });

    // Priority 5: More aggressive number changes
    for (let i = 6; i <= MAX_SERVER_NUM; i++) {
      if (i !== parsed.number) {
        add(parsed.prefix, i, parsed.root, parsed.tld, 5);
      }
    }

    // Sort by priority and deduplicate
    const sorted = candidates
      .sort((a, b) => a.priority - b.priority)
      .map(c => c.url);
    
    return [...new Set(sorted)].slice(0, MAX_ATTEMPTS);
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
          const pathKey = parsed.path.split('/').slice(0, 3).join('/');
          const cacheKey = `${parsed.root}-${pathKey}`;
          serverCache.set(cacheKey, {
            prefix: successParsed.prefix,
            number: successParsed.number,
            root: successParsed.root,
            tld: successParsed.tld
          });
        }
        
        // Apply the fix
        img.referrerPolicy = "no-referrer";
        img.src = url;
        
        // Update srcset if it exists
        if (img.srcset) {
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
    
    // Check cache first
    const pathKey = parsed.path.split('/').slice(0, 3).join('/');
    const cacheKey = `${parsed.root}-${pathKey}`;
    
    let newPrefix = 'n'; // Default k→n fix
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
    
    const newUrl = `https://${newPrefix}${String(newNumber).padStart(2, '0')}.${newRoot}.${newTld}${parsed.path}`;
    
    img.dataset.originalSrc = img.src;
    img.referrerPolicy = "no-referrer";
    img.src = newUrl;
    
    if (img.srcset) {
      img.dataset.originalSrcset = img.srcset;
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
        img.src = img.dataset.originalSrc;
        if (img.dataset.originalSrcset) {
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
    
    // Add error handler
    img.addEventListener('error', function() {
      // Small delay to prevent race conditions
      setTimeout(() => {
        if (img.dataset.batoFixing !== "done") {
          fixImage(img);
        }
      }, 100);
    }, { once: false }); // Allow multiple error events
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
