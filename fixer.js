(() => {
  
  const PROBE_TIMEOUT = 5000;
  const MAX_ATTEMPTS = 30; 
  const MAX_SERVER_NUM = 15; 
  
  
  const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
  const FALLBACK_ROOTS = ['mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org'];

  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d{1,3})\.([a-z0-9\-]+)\.(org|net|to)(\/.*)$/i;

  

  // 1. Probe a URL to see if it responds
  function probeUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      
      img.referrerPolicy = "no-referrer"; 
      
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        img.src = ""; 
        reject('timeout');
      }, PROBE_TIMEOUT);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(t);
          if (img.width > 10) resolve(true);
          else reject('empty');
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(t);
          reject('error');
        }
      };
      img.src = url;
    });
  }

  // 2. Parse URL
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

  // 3. Generate candidate URLs
  function generateCandidates(parsed) {
    const candidates = [];
    const add = (p, n, r, t) => {
      candidates.push(`https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`);
    };

    // Strategy A: Swap prefix (k02 -> n02)
    FALLBACK_PREFIXES.forEach(letter => {
      if (letter !== parsed.prefix) {
        add(letter, parsed.number, parsed.root, parsed.tld);
      }
    });

    // Strategy B: Swap root domains (mbdny -> mbrtz)
    FALLBACK_ROOTS.forEach(root => {
      const parts = root.split('.');
      if (parts.length === 2 && parts[0] !== parsed.root) {
        add(parsed.prefix, parsed.number, parts[0], parts[1]);
      }
    });

    // Strategy C: Increment Numbers (k02 -> k00..k15)
    for (let i = 0; i <= MAX_SERVER_NUM; i++) {
        if (i !== parsed.number) {
            add(parsed.prefix, i, parsed.root, parsed.tld);
        }
    }

    return [...new Set(candidates)].slice(0, MAX_ATTEMPTS);
  }

  function rewriteSrcset(srcset, workingUrl) {
      if (!srcset) return null;
      
      const workingParsed = parseSubdomain(workingUrl);
      if (!workingParsed) return null;
      
      // Construct the new base domain
      const newBase = `https://${workingParsed.prefix}${String(workingParsed.number).padStart(2, '0')}.${workingParsed.root}.${workingParsed.tld}`;
      
      
      // Matches: https://[letter][number].[root].[tld]
      return srcset.replace(/https?:\/\/[a-z]+\d{1,3}\.[a-z0-9\-]+\.(org|net|to)/gi, newBase);
  }


  async function fixImage(img) {
    if (img.dataset.batoFixing === "true" || img.dataset.batoFixing === "done") return;
    img.dataset.batoFixing = "true";

    const parsed = parseSubdomain(img.src);
    if (!parsed) return;

    const candidates = generateCandidates(parsed);

    for (const url of candidates) {
      try {
        await probeUrl(url);
        
        img.referrerPolicy = "no-referrer";
        
        // 2. Update the main source
        img.src = url;
        
        // 3. Update srcset (Responsive Images) if it exists
        if (img.srcset) {
            const newSrcset = rewriteSrcset(img.srcset, url);
            if (newSrcset) img.srcset = newSrcset;
        }

        img.dataset.batoFixing = "done";
        return;
      } catch (e) {
        // failed, try next
      }
    }
  }

  // 5. Check Logic
  function checkImage(img) {
    if (img.complete && img.naturalWidth === 0) {
      fixImage(img);
    }
  }

  // 6. Init
  function init() {
    // Check existing
    document.querySelectorAll('img').forEach(img => {
      checkImage(img);
      img.addEventListener('error', () => fixImage(img));
    });

    // Watch for new
    new MutationObserver((mutations) => {
      mutations.forEach(m => {
        m.addedNodes.forEach(node => {
          if (node.tagName === 'IMG') {
            node.addEventListener('error', () => fixImage(node));
            setTimeout(() => checkImage(node), 1000); 
          }
          
          if (node.querySelectorAll) {
              node.querySelectorAll('img').forEach(innerImg => {
                  innerImg.addEventListener('error', () => fixImage(innerImg));
                  checkImage(innerImg);
              });
          }
        });
        
        // Watch for changes to src OR srcset
        if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'srcset') && m.target.tagName === 'IMG') {
             if (m.target.dataset.batoFixing !== "done") {
                m.target.dataset.batoFixing = "false";
                setTimeout(() => checkImage(m.target), 2000);
             }
        }
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();