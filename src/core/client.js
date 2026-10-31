require('./polyfill');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { NoiseXXInitiator, concat } = require('./crypto');
const {
  encodeApplicationRequest,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeNoiseTransportFrame,
  decodeProtoFields,
  NoiseFrameDecoder
} = require('./proto');
const { extractWss, extractCookie, getWssExpiry, buildHybrid } = require('./credentials');

const DEFAULT_COOKIES = process.env.MUSE_COOKIES || '';

/**
 * Merge Set-Cookie headers into an existing "a=1; b=2" cookie string.
 * Cookies with Max-Age=0 / empty value are treated as deletions (but we never drop hatch_sess
 * unless a non-empty replacement is provided, since Meta sends a delete + a new value together).
 */
function mergeSetCookies(cookieStr, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return cookieStr;
  const jar = new Map();
  String(cookieStr || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) jar.set(k, v);
    }
  });
  for (const raw of setCookieHeaders) {
    const [kv, ...attrs] = String(raw).split(';');
    const idx = kv.indexOf('=');
    if (idx <= 0) continue;
    const k = kv.slice(0, idx).trim();
    const v = kv.slice(idx + 1).trim();
    const isDelete = !v || attrs.some(a => /max-age\s*=\s*0\b/i.test(a));
    if (isDelete) continue; // ignore deletions; the fresh value follows in the same response
    jar.set(k, v);
  }
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function extractCredentialsFromHtmlOrStream(text) {
  if (!text || typeof text !== 'string') return null;

  // Search for real non-null authToken anywhere in text / HTML stream
  // Format in JSON/HTML can be "authToken":"s0:..." or \"authToken\":\"s0:...\" or auth_token=...
  const authMatch = text.match(/authToken[\\]*"\s*:\s*[\\]*"([a-zA-Z0-9_\-\.:]+)[\\]*"/i) ||
                    text.match(/auth_token[\\]*"\s*:\s*[\\]*"([a-zA-Z0-9_\-\.:]+)[\\]*"/i) ||
                    text.match(/auth_token=([a-zA-Z0-9_\-\.:]+)/i);

  if (authMatch && authMatch[1] && authMatch[1] !== 'null') {
    const authToken = authMatch[1];

    const vmMatch = text.match(/vmName[\\]*"\s*:\s*[\\]*"([a-zA-Z0-9_\-]+)[\\]*"/i) ||
                    text.match(/vm_id[\\]*"\s*:\s*[\\]*"([a-zA-Z0-9_\-]+)[\\]*"/i) ||
                    text.match(/vm_id=([a-zA-Z0-9_\-]+)/i);

    const notaryMatch = text.match(/noiseNotaryToken[\\]*"\s*:\s*[\\]*"([a-zA-Z0-9_\-\.:]+)[\\]*"/i) ||
                        text.match(/notary_token=([a-zA-Z0-9_\-\.:]+)/i);

    const gatewayMatch = text.match(/gatewayUrl[\\]*"\s*:\s*[\\]*"([^"\\]+)[\\]*"/i);

    let vmId = vmMatch ? vmMatch[1] : null;
    if (!vmId && gatewayMatch) {
      try {
        vmId = new URL(gatewayMatch[1].replace(/\\\//g, '/')).hostname.split('.')[0];
      } catch (e) {}
    }

    if (vmId) {
      const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
      let wsUrl = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(authToken)}&app_id=hatch-web&request_id=${encodeURIComponent(requestId)}`;
      if (notaryMatch && notaryMatch[1] && notaryMatch[1] !== 'null') {
        wsUrl += `&notary_token=${encodeURIComponent(notaryMatch[1])}`;
      }
      return {
        vmName: vmId,
        vmId,
        authToken,
        noiseNotaryToken: (notaryMatch && notaryMatch[1] !== 'null') ? notaryMatch[1] : null,
        gatewayUrl: gatewayMatch ? gatewayMatch[1] : null,
        wsUrl
      };
    }
  }

  return null;
}

function parseGatewayInit(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  let str = rawInput.trim();

  // Strip trailing semicolons or parentheses
  str = str.replace(/;+\s*$/, '').trim();

  // Check if null or undefined
  if (str === 'null' || str === 'undefined' || str === '') return null;

  // Strategy 1: Check if text contains non-null credentials via regex extractor
  const streamCreds = extractCredentialsFromHtmlOrStream(str);
  if (streamCreds) return streamCreds;

  // If wrapped in outer quotes e.g. "..." or '...'
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    try {
      const unquoted = JSON.parse(str);
      if (typeof unquoted === 'object' && unquoted !== null) return unquoted;
      if (typeof unquoted === 'string') str = unquoted.trim();
    } catch (e) {
      str = str.slice(1, -1).trim();
    }
  }

  // Strategy 2: Direct JSON.parse
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string') {
      try {
        const doubleParsed = JSON.parse(parsed);
        if (doubleParsed && typeof doubleParsed === 'object') return doubleParsed;
      } catch (e) {}
    }
  } catch (e) {}

  // Strategy 3: If contains escaped quotes e.g. {\" or \"
  try {
    let replaced = str;
    replaced = replaced.replace(/\\"/g, '"');
    replaced = replaced.replace(/\\\//g, '/');
    const parsed = JSON.parse(replaced);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {}

  // Strategy 4: Find outermost { and } and extract
  const firstBrace = str.indexOf('{');
  const lastBrace = str.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    let bracketSlice = str.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(bracketSlice);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}

    try {
      bracketSlice = bracketSlice.replace(/\\"/g, '"').replace(/\\\//g, '/');
      const parsed = JSON.parse(bracketSlice);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {}
  }

  return null;
}

class MuseClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || null;
    this.cookies = options.cookies || DEFAULT_COOKIES;
    this.proxy = options.proxy || process.env.MUSE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
    this.ws = null;
    this.sendCipher = null;
    this.recvCipher = null;
    this.streamCounter = 1n;
    this.frameDecoder = new NoiseFrameDecoder();
    this.decoder = new TextDecoder();
    this.pendingStreams = new Map();
    this.activeSessionId = null;
    this.deviceId = 'hatch-' + Math.random().toString(36).substring(2, 12);
    this.highestSeq = 0;
    this.sendQueue = Promise.resolve();
  }

  /**
   * Safely disconnect WebSocket session
   */
  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }

  /**
   * Fetch a fresh WebSocket URL from muse.ai using cookies or parse directly from provided credentials
   */
  async bootstrap() {
    if (this.wsUrl) return this.wsUrl;
    if (!this.cookies) throw new Error('Either wsUrl, cookies or __HATCH_GATEWAY_INIT__ must be provided');

    // 1. Direct WebSocket URL Check (e.g. wss://hatch.metaaivm.com/...)
    //    Hybrid mode: "wss://...\n<cookie hatch_sess=...>" -> use wss while valid, regenerate from cookie when expired.
    const directWss = extractWss(this.cookies);
    if (directWss) {
      const hybridCookie = extractCookie(this.cookies);
      const exp = getWssExpiry(directWss);
      const stillValid = !exp || exp - Date.now() > 5 * 60 * 1000;
      if (!hybridCookie || (stillValid && !this.forceRefresh)) {
        if (exp && exp <= Date.now()) {
          const err = new Error(`The wss:// WebSocket URL expired at ${new Date(exp).toISOString()}. Attach the session cookie (hatch_sess=...) so the server can renew it automatically.`);
          err.code = 'MUSE_AUTH_EXPIRED';
          throw err;
        }
        this.wsUrl = directWss;
        console.log('[Bootstrap] Using direct WebSocket URL provided in credentials.');
        return this.wsUrl;
      }
      console.log('[Bootstrap] wss:// link expired/forced refresh -> regenerating from attached cookie...');
      this.hybridMode = true;
      this.cookies = hybridCookie;
    }

    // 2. Direct __HATCH_GATEWAY_INIT__ Credentials Check (Bypasses web scraping & datacenter IP blocks completely!)
    const directInit = parseGatewayInit(this.cookies);
    if (directInit && directInit.authToken) {
      let vmId = directInit.vmName;
      if (!vmId && directInit.gatewayUrl) {
        try {
          vmId = new URL(directInit.gatewayUrl).hostname.split('.')[0];
        } catch (e) {}
      }
      if (vmId && directInit.authToken) {
        const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        let url = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(directInit.authToken)}&app_id=hatch-web&request_id=${encodeURIComponent(requestId)}`;
        if (directInit.noiseNotaryToken) {
          url += `&notary_token=${encodeURIComponent(directInit.noiseNotaryToken)}`;
        }
        this.wsUrl = url;
        console.log(`[Bootstrap] Successfully derived WebSocket URL from directly provided __HATCH_GATEWAY_INIT__ for VM: ${vmId}`);
        return this.wsUrl;
      }
    }

    // 3. Fallback: Query Meta Muse AI using cookies
    this.fromCookie = true;
    let cleanCookies = typeof this.cookies === 'string' ? this.cookies.trim() : '';
    if (cleanCookies.toLowerCase().startsWith('cookie:')) cleanCookies = cleanCookies.slice(7).trim();
    if ((cleanCookies.startsWith('"') && cleanCookies.endsWith('"')) || (cleanCookies.startsWith("'") && cleanCookies.endsWith("'"))) {
      cleanCookies = cleanCookies.slice(1, -1).trim();
    }
    cleanCookies = cleanCookies.replace(/\r/g, '').replace(/\n+/g, ' ').trim();

    const proxyUrl = this.proxy || process.env.MUSE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    let httpsAgent = null;
    if (proxyUrl) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        httpsAgent = new HttpsProxyAgent(proxyUrl);
        console.log(`[Bootstrap] Routing muse.ai request through proxy: ${proxyUrl.replace(/:\/\/.*@/, '://***@')}`);
      } catch (err) {
        console.warn('[Bootstrap] Warning: Could not initialize HttpsProxyAgent:', err.message);
      }
    }

    // Strategy 3A: Direct Meta Muse REST API (/api/session -> /api/hatch/token)
    // Works reliably on VPS, cloud datacenters, and local machines without HTML SSR scraping dependency!
    let lastApiError = null;
    const maxSessionRetries = 3;
    for (let attempt = 1; attempt <= maxSessionRetries; attempt++) {
      try {
        console.log(`[Bootstrap] Querying Meta Muse Session API (attempt ${attempt}/${maxSessionRetries}: GET https://muse.ai/api/session?vm_state=live) ...`);
        const restHeaders = {
          'cookie': cleanCookies,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'accept': '*/*',
          'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'origin': 'https://muse.ai',
          'referer': 'https://muse.ai/',
          'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin'
        };

        const restConfig = {
          headers: restHeaders,
          validateStatus: () => true,
          timeout: 15000
        };
        if (httpsAgent) {
          restConfig.httpsAgent = httpsAgent;
          restConfig.proxy = false;
        }

        const sessionRes = await axios.get('https://muse.ai/api/session?vm_state=live', restConfig);

        // Rotate cookies if provided
        const mergedSession = mergeSetCookies(cleanCookies, sessionRes.headers && sessionRes.headers['set-cookie']);
        if (mergedSession && mergedSession !== cleanCookies) {
          cleanCookies = mergedSession;
          this.refreshedCookies = mergedSession;
          this.cookies = mergedSession;
          restHeaders.cookie = cleanCookies;
        }

        if (sessionRes.status === 401) {
          const err = new Error('The Meta session cookie has expired (upstream responded HTTP 401: Authentication required). Sign in again and update the account with a fresh cookie (hatch_sess=...).');
          err.code = 'MUSE_AUTH_EXPIRED';
          throw err;
        }

        if (sessionRes.status === 200 && sessionRes.data) {
          const sessionData = sessionRes.data;
          const vmId = sessionData.vm_id || sessionData.vm_name || (sessionData.vms && sessionData.vms[0] && (sessionData.vms[0].vm_id || sessionData.vms[0].id));
          const endpointUrl = sessionData.endpoint_url || (sessionData.vms && sessionData.vms[0] && sessionData.vms[0].endpoint_url) || (vmId ? `wss://${vmId}.metaaivm.com/` : null);

          if (vmId && endpointUrl) {
            console.log(`[Bootstrap] Meta assigned live VM ${vmId}. Requesting hatch token...`);
            let tokenRes = null;
            for (let tAttempt = 1; tAttempt <= 2; tAttempt++) {
              tokenRes = await axios.post('https://muse.ai/api/hatch/token', {
                vmAddress: endpointUrl,
                vmName: vmId
              }, restConfig);
              if (tokenRes.status === 200 && tokenRes.data && tokenRes.data.token) break;
              if (tAttempt < 2) await new Promise(r => setTimeout(r, 1000));
            }

            const mergedToken = mergeSetCookies(cleanCookies, tokenRes && tokenRes.headers && tokenRes.headers['set-cookie']);
            if (mergedToken && mergedToken !== cleanCookies) {
              cleanCookies = mergedToken;
              this.refreshedCookies = mergedToken;
              this.cookies = mergedToken;
            }

            if (tokenRes && tokenRes.status === 200 && tokenRes.data && tokenRes.data.token) {
              const { token, notary_token } = tokenRes.data;
              const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
              let url = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(token)}&app_id=hatch-web&request_id=${encodeURIComponent(requestId)}`;
              if (notary_token) {
                url += `&notary_token=${encodeURIComponent(notary_token)}`;
              }
              this.wsUrl = url;
              console.log(`[Bootstrap] Successfully retrieved WebSocket URL via Meta REST APIs for VM: ${vmId}`);
              return this.wsUrl;
            } else {
              console.warn(`[Bootstrap] /api/hatch/token returned non-200 status (${tokenRes?.status}):`, tokenRes?.data);
              lastApiError = new Error(`/api/hatch/token responded with HTTP ${tokenRes?.status || 'unknown'}`);
            }
          } else {
            console.warn(`[Bootstrap] Meta session is warming up/provisioning (status: ${sessionData.status}, vm_state: ${sessionData.vm_state || 'none'}). Waiting 1.5s...`);
            lastApiError = new Error(`The upstream VM is still starting (status: ${sessionData.status || 'pending_assignment'}).`);
          }
        } else {
          lastApiError = new Error(`GET /api/session responded with HTTP ${sessionRes.status}`);
        }
      } catch (apiErr) {
        if (apiErr.code === 'MUSE_AUTH_EXPIRED') {
          throw apiErr;
        }
        lastApiError = apiErr;
        console.warn(`[Bootstrap] Meta REST API attempt ${attempt} failed:`, apiErr.message);
      }

      if (attempt < maxSessionRetries) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Strategy 3B: Fallback to HTML SSR scraping (Legacy / Backup)
    console.log('[Bootstrap] Fallback: Fetching fresh session credentials from HTML SSR at https://muse.ai/ ...');

    const axiosConfig = {
      headers: {
        'cookie': cleanCookies,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'max-age=0',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1'
      },
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 5
    };

    if (httpsAgent) {
      axiosConfig.httpsAgent = httpsAgent;
      axiosConfig.proxy = false;
    }

    const res = await axios.get('https://muse.ai/', axiosConfig);

    // Meta rotates hatch_sess / hatch_gw / hatch_vml on every visit (Max-Age 30 days).
    // Merge them so the caller can persist the fresh cookie -> account never expires while in use.
    const merged = mergeSetCookies(cleanCookies, res.headers && res.headers['set-cookie']);
    if (merged && merged !== cleanCookies) {
      this.refreshedCookies = merged;
      this.cookies = merged;
      console.log('[Bootstrap] Meta issued rotated session cookies (will be persisted).');
    }

    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Strategy A (Fastest & Modern): Extract credentials directly from Next.js RSC flight chunks / HTML stream
    const streamCreds = extractCredentialsFromHtmlOrStream(html);
    if (streamCreds && streamCreds.wsUrl) {
      this.wsUrl = streamCreds.wsUrl;
      console.log(`[Bootstrap] Successfully extracted active session credentials from stream chunks for VM: ${streamCreds.vmId}`);
      return this.wsUrl;
    }

    // Strategy B: Fallback to parsing window.__HATCH_GATEWAY_INIT__
    const pos = html.indexOf('window.__HATCH_GATEWAY_INIT__=');
    if (pos === -1) {
      if (res.status === 307 || res.status === 302) {
        throw new Error(`Upstream redirected to the login page (HTTP ${res.status}). The cookie session is no longer valid.`);
      }
      const apiDetail = lastApiError ? ` (${lastApiError.message})` : '';
      throw new Error(
        `Unable to reach the upstream VM through the session API${apiDetail}.\n` +
        `>> The account cookie may have expired or the session needs to be refreshed.\n` +
        `>> Sign in again in a browser to obtain a fresh cookie (hatch_sess=...), or provide a wss:// URL directly.`
      );
    }

    const end = html.indexOf(';', pos);
    let raw = html.slice(pos + 'window.__HATCH_GATEWAY_INIT__='.length, end !== -1 ? end : undefined).trim();

    const init = parseGatewayInit(raw);

    if (!init || typeof init !== 'object' || raw === 'null' || !init.authToken) {
      // Strategy 3C: Fallback to Chromium browser automation
      try {
        console.log('[Bootstrap] Fallback: Launching headless Chromium to extract active WebSocket URL from cookie...');
        const { extractWssViaChromium, detectChromium } = require('./browser');
        if (detectChromium()) {
          const browserRes = await extractWssViaChromium(cleanCookies, { proxy: proxyUrl, timeoutMs: 35000 });
          if (browserRes && browserRes.wsUrl) {
            this.wsUrl = browserRes.wsUrl;
            if (browserRes.refreshedCookies) {
              this.refreshedCookies = browserRes.refreshedCookies;
              this.cookies = browserRes.refreshedCookies;
            }
            console.log(`[Bootstrap] Successfully extracted active WebSocket URL via Chromium for VM: ${browserRes.vmId}`);
            return this.wsUrl;
          }
        }
      } catch (browserErr) {
        console.warn('[Bootstrap] Chromium extraction attempt failed:', browserErr.message);
      }

      throw new Error(
        'The cookie was rejected or this server IP is blocked by upstream (VM info returned null).\n' +
        '>> QUICK FIX:\n' +
        '1. Sign in from a desktop browser, open DevTools > Network, find the WebSocket request "noise?vm_id=..." and register that wss:// URL (wss:// URLs are not IP-restricted).\n' +
        '2. Or, to let the server renew wss:// URLs from the cookie automatically, set MUSE_PROXY=http://... (residential proxy) in .env, or install Chromium on the host.'
      );
    }

    const vmId = init.vmName || (init.gatewayUrl ? new URL(init.gatewayUrl).hostname.split('.')[0] : null);
    if (!vmId) throw new Error('Upstream gateway initialization did not contain a VM identifier.');
    const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);

    let url = `wss://hatch.metaaivm.com/v1/noise?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(init.authToken)}&app_id=hatch-web&request_id=${encodeURIComponent(requestId)}`;
    if (init.noiseNotaryToken) {
      url += `&notary_token=${encodeURIComponent(init.noiseNotaryToken)}`;
    }

    this.wsUrl = url;
    console.log(`[Bootstrap] Generated fresh WebSocket URL for VM: ${vmId}`);
    return this.wsUrl;
  }

  /**
   * Connect and execute the Noise XX Handshake
   */
  async connect() {
    if (!this.wsUrl) {
      await this.bootstrap();
    }
    // A fresh wss:// was generated from the cookie -> caller persists "newWss\ncookie" (wss is always stored)
    if (this.hybridMode || this.fromCookie) {
      this.refreshedCredential = buildHybrid(this.wsUrl, this.cookies);
    }

    const noise = new NoiseXXInitiator();
    await noise.initialize();
    const clientNonce = new Uint8Array(32);
    globalThis.crypto.getRandomValues(clientNonce);
    const msg1 = await noise.writeMessage1(concat(new Uint8Array([10, 32]), clientNonce));

    return new Promise((resolve, reject) => {
      const wsOptions = {
        headers: {
          'Origin': 'https://muse.ai',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }
      };

      const proxyUrl = this.proxy || process.env.MUSE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxyUrl) {
        try {
          const { HttpsProxyAgent } = require('https-proxy-agent');
          wsOptions.agent = new HttpsProxyAgent(proxyUrl);
        } catch (e) {
          console.warn('[Connect] Warning: Could not initialize HttpsProxyAgent for WebSocket:', e.message);
        }
      }

      this.ws = new WebSocket(this.wsUrl, wsOptions);

      let isHandshaking = true;
      let connectSettled = false;
      let settleInterval = null;
      let onAnyEvent = null;

      const clearSettleWatcher = () => {
        if (settleInterval) {
          clearInterval(settleInterval);
          settleInterval = null;
        }
        if (onAnyEvent) {
          this.off('event', onAnyEvent);
          onAnyEvent = null;
        }
      };

      const handshakeTimer = setTimeout(() => {
        if (connectSettled) return;
        isHandshaking = false;
        connectSettled = true;
        clearSettleWatcher();
        reject(new Error('Upstream WebSocket handshake timed out.'));
        this.close();
      }, 60000);
      handshakeTimer.unref?.();

      this.ws.on('open', () => {
        this.ws.send(msg1);
      });

      // Strict FIFO message queue for WebSocket frames
      // Prevents WebCrypto / AES-GCM thread pool race conditions where smaller
      // frames decrypt faster than larger frames, causing frames to be handled out of order
      // which corrupts base64 strings and WebP/MP4 bitstreams!
      let messageQueue = Promise.resolve();

      this.ws.on('message', (data) => {
        messageQueue = messageQueue.then(async () => {
          const buf = new Uint8Array(data);

          if (isHandshaking) {
            try {
              await noise.readMessage2(buf);
              const msg3 = await noise.writeMessage3(new Uint8Array(0));
              this.ws.send(msg3);
              const [csSend, csRecv] = await noise.split();
              this.sendCipher = csSend;
              this.recvCipher = csRecv;
              isHandshaking = false;
              clearTimeout(handshakeTimer);

              // Heartbeat: WS ping every 25s keeps the authenticated socket open as long as possible,
              // so we don't have to re-handshake with a (possibly expired) wss:// token.
              if (this._pingTimer) clearInterval(this._pingTimer);
              this._pingTimer = setInterval(() => {
                try { if (this.ws && this.ws.readyState === 1) this.ws.ping(); } catch (e) {}
              }, 25000);
              if (this._pingTimer.unref) this._pingTimer.unref();
              // Subscribe to chat events in background after handshake
              this.subscribe().catch((err) => console.error('[Subscribe Error]:', err));

              // Wait until replay events settle (quiet for 400ms or max 1500ms)
              const startTime = Date.now();
              let lastEventTime = Date.now();
              onAnyEvent = () => { lastEventTime = Date.now(); };
              this.on('event', onAnyEvent);

              settleInterval = setInterval(() => {
                const now = Date.now();
                if (now - lastEventTime >= 350 || now - startTime >= 1500) {
                  clearSettleWatcher();
                  if (!connectSettled) {
                    connectSettled = true;
                    resolve();
                  }
                }
              }, 100);
            } catch (err) {
              clearTimeout(handshakeTimer);
              clearSettleWatcher();
              if (!connectSettled) {
                connectSettled = true;
                reject(err);
              }
              this.close();
            }
            return;
          }

          try {
            const decrypted = await this.recvCipher.decryptWithAd(new Uint8Array(0), buf);
            this.handleDecryptedFrame(decrypted);
          } catch (err) {
            this.safeEmitError(err);
          }
        }).catch(err => {
          this.safeEmitError(err);
        });
      });

      this.ws.on('error', (err) => {
        // Make 401/403 from Meta gateway human-readable (expired auth_token / notary_token in wss:// link)
        if (err && /Unexpected server response: (401|403)/.test(err.message || '')) {
          err.code = 'MUSE_AUTH_EXPIRED';
          err.message = 'Upstream VM rejected the connection (HTTP 403): the wss:// URL or cookie has expired. Update the account credentials.';
        }
        if (!connectSettled) {
          // During handshake/settle the caller handles the failure via the rejected Promise.
          // Never emit here: no 'error' listener is attached yet -> would crash the whole process.
          isHandshaking = false;
          connectSettled = true;
          clearTimeout(handshakeTimer);
          clearSettleWatcher();
          reject(err);
          return;
        }
        this.safeEmitError(err);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(handshakeTimer);
        clearSettleWatcher();
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        if (this.frameDecoder?.pending) this.frameDecoder.pending.clear();
        if (!connectSettled) {
          isHandshaking = false;
          connectSettled = true;
          reject(new Error(`WebSocket closed before the handshake completed (code ${code}).`));
        }
        // Reject all pending streams so requests don't hang indefinitely
        for (const [sId, stream] of this.pendingStreams.entries()) {
          try {
            stream.reject(new Error(`WebSocket connection to the upstream VM closed (code ${code}, reason: ${reason || 'none'}).`));
          } catch (e) {}
        }
        this.pendingStreams.clear();
        this.emit('close', { code, reason: reason ? reason.toString() : '' });
      });
    });
  }

  /**
   * Emit 'error' only if someone is listening. EventEmitter throws (and crashes Node)
   * when 'error' is emitted without listeners.
   */
  safeEmitError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    } else {
      console.warn('[MuseClient] Socket error (no listener):', err && err.message);
    }
  }

  async subscribe() {
    return this.sendRequest('POST', '/chat/subscribe', {
      after_stream_seq: 0,
      after_chat_event_seq: 0,
      capabilities: [
        "chat_cancel",
        "delta_stream",
        "custom_reactions",
        "custom_reactions_facebook_thumbs_up_v1"
      ]
    }, [], true);
  }

  async sendRequest(method, path, bodyObj = null, headers = [], resolveOnStatus = false, serviceType = null, { signal } = {}) {
    signal?.throwIfAborted();
    let resolvedServiceType = 0; // 0 = SERVICE_DAEMON
    if (serviceType !== null && serviceType !== undefined) {
      resolvedServiceType = serviceType;
    } else if (path.startsWith('/approvals') || path.startsWith('/permissions')) {
      resolvedServiceType = 1; // 1 = SERVICE_SENTINEL
    }

    const streamId = this.streamCounter++;
    const defaultHeaders = [
      { key: 'accept', value: 'application/json' },
      ...headers
    ];

    let bodyBytes = new Uint8Array(0);
    if (bodyObj !== null) {
      bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));
      defaultHeaders.push({ key: 'content-type', value: 'application/json' });
    }

    const appReq = encodeApplicationRequest(method, path, defaultHeaders, bodyBytes, true);
    const svcFrame = encodeServiceFrame(streamId, appReq);
    const svcReq = encodeServiceRequest(resolvedServiceType, svcFrame);

    // Noise protocol maximum payload per frame is 65535 bytes.
    // We safely fragment large payloads into 32KB slices so uploads of any size never drop the connection.
    const CHUNK_SIZE = 32000;
    const totalChunks = Math.max(1, Math.ceil(svcReq.length / CHUNK_SIZE));
    const chunkId = streamId;
    const socket = this.ws;
    const cipher = this.sendCipher;

    return new Promise((resolve, reject) => {
      const streamKey = streamId.toString();
      const abort = () => {
        const pending = this.pendingStreams.get(streamKey);
        this.pendingStreams.delete(streamKey);
        pending?.reject(signal.reason || new Error('Upstream request aborted.'));
      };
      const timeoutMs = 60000;
      const timeoutTimer = setTimeout(() => {
        const pending = this.pendingStreams.get(streamKey);
        this.pendingStreams.delete(streamKey);
        pending?.reject(new Error(`Upstream request (${method} ${path}) timed out after ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();

      this.pendingStreams.set(streamKey, {
        resolve: (val) => {
          clearTimeout(timeoutTimer);
          signal?.removeEventListener('abort', abort);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timeoutTimer);
          signal?.removeEventListener('abort', abort);
          reject(err);
        },
        chunks: [],
        status: null,
        buffer: '',
        resolveOnStatus,
        decoder: new TextDecoder()
      });
      signal?.addEventListener('abort', abort, { once: true });

      // Register the response before sending, and serialize encryption AND send.
      const send = async () => {
        if (!this.pendingStreams.has(streamKey)) return;
        for (let i = 0; i < totalChunks; i++) {
          signal?.throwIfAborted();
          if (this.ws !== socket || socket?.readyState !== 1 || !cipher) {
            throw new Error('Upstream socket is not connected.');
          }
          const slice = svcReq.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const frame = encodeNoiseTransportFrame(chunkId, i, totalChunks, slice);
          const encrypted = await cipher.encryptWithAd(new Uint8Array(0), frame);
          // Once a nonce is consumed, its frame must be sent even if aborted.
          await new Promise((sent, failed) => socket.send(encrypted, (err) => err ? failed(err) : sent()));
        }
      };
      this.sendQueue = this.sendQueue.then(send).catch((err) => {
        const pending = this.pendingStreams.get(streamKey);
        this.pendingStreams.delete(streamKey);
        pending?.reject(err);
        if (!signal?.aborted && this.ws === socket) this.close();
      });
      if (signal?.aborted) abort();
    });
  }

  handleDecryptedFrame(frame) {
    const fields = decodeProtoFields(frame);
    const chunkIdField = fields.find(f => f.fieldNum === 1);
    const chunkIndexField = fields.find(f => f.fieldNum === 2);
    const totalChunksField = fields.find(f => f.fieldNum === 3);
    const payloadField = fields.find(f => f.fieldNum === 4);

    if (!payloadField) return;

    const chunkId = chunkIdField ? chunkIdField.value : 0n;
    const chunkIndex = chunkIndexField ? Number(chunkIndexField.value) : 0;
    const totalChunks = totalChunksField ? Number(totalChunksField.value) : 1;

    const assembled = this.frameDecoder.decode(chunkId, chunkIndex, totalChunks, payloadField.value);
    if (!assembled) return; // Wait for the remaining chunks to arrive

    const svcRespFields = decodeProtoFields(assembled);
    const svcFrameField = svcRespFields.find(f => f.fieldNum === 1);
    if (!svcFrameField) return;

    const frameFields = decodeProtoFields(svcFrameField.value);
    const streamIdField = frameFields.find(f => f.fieldNum === 1);
    const streamId = streamIdField ? streamIdField.value.toString() : 'unknown';

    const stream = this.pendingStreams.get(streamId);

    const appRespField = frameFields.find(f => f.fieldNum === 3);
    if (appRespField) {
      const appRespFields = decodeProtoFields(appRespField.value);
      const statusField = appRespFields.find(f => f.fieldNum === 1);
      if (stream) {
        stream.status = statusField ? Number(statusField.value) : 200;
        if (stream.resolveOnStatus) {
          stream.resolve({ status: stream.status });
        }
      }
      const bodyField = appRespFields.find(f => f.fieldNum === 3);
      if (bodyField && bodyField.value.length > 0) {
        const text = stream?.decoder ? stream.decoder.decode(bodyField.value) : this.decoder.decode(bodyField.value);
        this.processStreamText(stream, text);
      }

      const endBodyField = appRespFields.find(f => f.fieldNum === 4);
      const isEnd = endBodyField ? Boolean(endBodyField.value) : false;
      if (isEnd && stream && !stream.resolveOnStatus) {
        stream.resolve({
          status: stream.status,
          body: stream.chunks.join('')
        });
        this.pendingStreams.delete(streamId);
      }
    }

    const bodyChunkField = frameFields.find(f => f.fieldNum === 4);
    if (bodyChunkField) {
      const bcFields = decodeProtoFields(bodyChunkField.value);
      const dataField = bcFields.find(f => f.fieldNum === 1);
      const endBodyField = bcFields.find(f => f.fieldNum === 2);
      const isEnd = endBodyField ? Boolean(endBodyField.value) : false;

      if (dataField && dataField.value.length > 0) {
        const text = stream?.decoder ? stream.decoder.decode(dataField.value, { stream: !isEnd }) : this.decoder.decode(dataField.value, { stream: !isEnd });
        this.processStreamText(stream, text);
      }

      if (isEnd && stream) {
        stream.resolve({
          status: stream.status,
          body: stream.chunks.join('')
        });
        if (!stream.resolveOnStatus) {
          this.pendingStreams.delete(streamId);
        }
      }
    }
  }

  processStreamText(stream, text) {
    if (!text) return;
    if (stream) {
      stream.chunks.push(text);
      stream.buffer += text;
    } else {
      this.globalEventBuffer = (this.globalEventBuffer || '') + text;
    }

    const buf = stream ? stream.buffer : this.globalEventBuffer;
    const lines = buf.split('\n');
    const remainder = lines.pop();
    if (stream) {
      stream.buffer = remainder;
    } else {
      this.globalEventBuffer = remainder;
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        this.handleEvent(json);
      } catch (e) {
        // Not a complete JSON or plain text
      }
    }
  }

  handleEvent(event) {
    if (typeof event.seq === 'number' && event.seq > this.highestSeq) {
      this.highestSeq = event.seq;
    }

    this.emit('event', event);

    if (event.event === 'delta.text_append') {
      const text = event.payload?.text || '';
      if (event.payload?.session_id) {
        this.activeSessionId = event.payload.session_id;
      }
      this.emit('text_delta', text, event.payload, event.seq);
    } else if (event.event === 'delta.presentation') {
      this.emit('presentation', event.payload, event.seq);
    } else if (event.event === 'delta.message_done') {
      this.emit('message_done', event.payload, event.seq);
    } else if (event.event === 'agent.status') {
      this.emit('agent_status', event.payload, event.seq);
    } else if (event.event === 'approvals.snapshot') {
      this.emit('approval_snapshot', event.payload, event.seq);
      const pending = event.payload?.pending_approvals || event.payload?.pending || [];
      if (Array.isArray(pending)) {
        for (const item of pending) {
          const appId = item.approval_id || item.approvalId;
          const status = item.status || 'pending';
          if (appId && status === 'pending') {
            const decision = this.egressDecisionFor(item);
            if (decision === 'deny') {
              this.denyEgress(appId, item);
            } else {
              console.log(`[MuseClient] Auto-approving network/egress permission for: ${appId} (target: ${item.host || item.policy_subject || 'network'})`);
              this.decideApproval(appId, 'allow_once').catch(() => {});
            }
          }
        }
      }
    } else if (event.event?.includes('approval')) {
      const appId = event.payload?.approval_id || event.payload?.approvalId;
      const status = event.payload?.status || 'pending';
      if (appId && status === 'pending') {
        const decision = this.egressDecisionFor(event.payload);
        if (decision === 'deny') {
          this.denyEgress(appId, event.payload);
        } else {
          console.log(`[MuseClient] Auto-approving single egress request: ${appId}`);
          this.decideApproval(appId, 'allow_once').catch(() => {});
        }
      }
    }
  }

  /**
   * Chat Media Guard: while a guarded chat turn is running, sandbox egress
   * (network uploads) is denied so generated media cannot be exfiltrated to
   * third-party hosts. Approvals without a session id are denied whenever any
   * guarded turn is active on this client (fail closed).
   */
  egressDecisionFor(item) {
    if (!this.guardedSessions || this.guardedSessions.size === 0) return 'allow_once';
    const sId = item?.session_id || item?.chat_context?.chat_id || item?.chat_id || null;
    if (!sId || this.guardedSessions.has(sId)) return 'deny';
    return 'allow_once';
  }

  denyEgress(appId, item) {
    if (!this.deniedApprovals) this.deniedApprovals = new Set();
    if (this.deniedApprovals.has(appId)) return;
    this.deniedApprovals.add(appId);
    if (this.deniedApprovals.size > 500) this.deniedApprovals = new Set([...this.deniedApprovals].slice(-200));
    console.warn(`[ChatGuard] Denied sandbox egress during guarded chat turn: ${appId} (target: ${item?.host || item?.policy_subject || 'network'})`);
    // Unknown decision values are rejected upstream; the approval then simply stays pending (egress still blocked).
    this.decideApproval(appId, 'deny').catch(() => {});
  }

  /**
   * Decide on a security/egress approval (Sentinel service)
   */
  async decideApproval(approvalId, decision = 'allow_once') {
    if (!approvalId) return null;
    const cleanId = String(approvalId).trim();
    try {
      const res = await this.sendRequest(
        'POST',
        `/approvals/${encodeURIComponent(cleanId)}/decide`,
        { decision },
        [],
        false,
        1 // SERVICE_SENTINEL
      );
      console.log(`[MuseClient] Egress approval ${cleanId} decided: "${decision}" (HTTP ${res?.status})`);
      return res;
    } catch (err) {
      console.warn(`[MuseClient] Failed to decide approval ${cleanId} via Sentinel:`, err.message);
      try {
        const fallbackRes = await this.sendRequest(
          'POST',
          `/approvals/${encodeURIComponent(cleanId)}/decide`,
          { decision },
          [],
          false,
          0 // SERVICE_DAEMON fallback
        );
        return fallbackRes;
      } catch (e) {
        throw err;
      }
    }
  }

  /**
   * Read raw file from VM via /fs/read with safe chunking and verification
   */
  async readFile(filePath, maxBytes = 100 * 1024 * 1024, { signal } = {}) {
    // Strip sandbox:// if present
    const cleanPath = filePath.replace(/^sandbox:\/\//, '');
    let offset = 0;
    // 128KB chunk size guarantees fast downloads without oversized WebSocket payload fragmentation
    const chunkSize = 128 * 1024;
    const buffers = [];

    while (offset <= maxBytes) {
      signal?.throwIfAborted();
      const res = await this.sendRequest('POST', '/fs/read', {
        path: cleanPath,
        offset,
        len: Math.min(chunkSize, maxBytes - offset + 1)
      }, [], false, null, { signal });

      if (res.status !== 200) {
        throw new Error(`Failed to read file ${cleanPath}: HTTP ${res.status} ${res.body}`);
      }

      const json = JSON.parse(res.body);
      if (!json.ok || !json.result) {
        throw new Error(`Failed to read file ${cleanPath}: ${res.body}`);
      }

      const { data_base64, eof, len } = json.result;
      if (data_base64) {
        const decoded = Buffer.from(data_base64, 'base64');
        if (offset + decoded.length > maxBytes) {
          throw new Error(`Upstream file exceeds the ${maxBytes} byte download limit.`);
        }
        buffers.push(decoded);
        offset += decoded.length;
      }

      if (eof) break;
      if (len === 0 || !data_base64 || Buffer.from(data_base64, 'base64').length === 0) {
        throw new Error('Upstream file read stopped before EOF.');
      }
    }

    return Buffer.concat(buffers);
  }

  /**
   * Write raw file to VM via /fs/write with automatic chunking
   */
  async writeFile(filePath, bufferOrBase64, options = {}) {
    const cleanPath = filePath.replace(/^\/+/, '').replace(/^sandbox:\/\//, '');
    let buffer;
    if (Buffer.isBuffer(bufferOrBase64)) {
      buffer = bufferOrBase64;
    } else if (typeof bufferOrBase64 === 'string') {
      const b64Data = bufferOrBase64.includes(';base64,') ? bufferOrBase64.split(';base64,')[1] : bufferOrBase64;
      buffer = Buffer.from(b64Data, 'base64');
    } else {
      buffer = Buffer.from(bufferOrBase64 || '');
    }

    const chunkSize = 256 * 1024; // 256KB chunks per /fs/write call (safe payload size)
    let offset = 0;
    const total = buffer.length;

    if (total === 0) {
      const res = await this.sendRequest('POST', '/fs/write', {
        path: cleanPath,
        data_base64: '',
        offset: 0,
        overwrite: options.overwrite !== false,
        append: false,
        create_parent: true
      });
      return { path: cleanPath, bytesWritten: 0 };
    }

    let bytesWritten = 0;
    while (offset < total) {
      const chunk = buffer.slice(offset, offset + chunkSize);
      const isFirst = (offset === 0);
      const res = await this.sendRequest('POST', '/fs/write', {
        path: cleanPath,
        data_base64: chunk.toString('base64'),
        offset: offset,
        overwrite: isFirst ? (options.overwrite !== false) : false,
        append: !isFirst,
        create_parent: true
      });

      if (res.status !== 200) {
        throw new Error(`Failed to write file ${cleanPath} at offset ${offset}: HTTP ${res.status} ${res.body}`);
      }

      const json = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      if (!json.ok) {
        throw new Error(`Failed to write file ${cleanPath}: ${JSON.stringify(json.error || json)}`);
      }

      bytesWritten += chunk.length;
      offset += chunkSize;
    }

    return { path: cleanPath, bytesWritten };
  }

  /**
   * Send a prompt (and optional reference image/video) to Muse AI and stream tokens
   */
  async chat(prompt, options = {}) {
    options.signal?.throwIfAborted();
    const onToken = typeof options === 'function' ? options : options.onToken;
    const onEvent = options.onEvent;
    const mediaPaths = p => [p?.image_path, ...(p?.data?.images || []).map(x => x.path), ...(p?.data?.videos || []).map(x => x.path)].filter(Boolean);
    const previousPaths = new Set();
    let previousUserIndex = -1;
    if (options.sessionId && options.waitForKind) {
      const history = await this.sendRequest('GET', `/chat/history?session_id=${options.sessionId}`, null, [], false, null, { signal: options.signal });
      if (history.status !== 200 && history.status !== 404) throw new Error('Could not establish the retained session turn boundary.');
      if (history.status === 200 && history.body) {
        const events = JSON.parse(history.body).result?.chat_events || [];
        previousUserIndex = events.map(e => e.role === 'user' || e.event_name === 'message.user').lastIndexOf(true);
        for (const event of events) {
          const p = event.payload || event;
          for (const presentation of [p, ...(p.presentations || [])]) {
            for (const path of mediaPaths(presentation)) previousPaths.add(path);
          }
        }
      }
    }
    const isCurrentMedia = p => !mediaPaths(p).some(path => previousPaths.has(path));

    return new Promise((resolve, reject) => {
      let fullResponse = '';
      const presentations = [];
      let isDone = false;
      let debounceTimer = null;
      let overallTimer = null;

      const hasExpectedMedia = () => {
        if (options.waitForKind === 'video') {
          return presentations.some(p => (p.kind === 'video' || p.data?.videos?.length > 0) && mediaPaths(p).length > 0);
        }
        if (options.waitForKind === 'image') {
          return presentations.some(p => (p.kind === 'image' || p.data?.images?.length > 0) && mediaPaths(p).length > 0);
        }
        return false;
      };

      const hasTurnContent = () => {
        if (options.waitForKind) return hasExpectedMedia();
        return fullResponse.length > 0;
      };

      const normalizeSessionUUID = (sId) => {
        if (!sId) return null;
        const str = String(sId).trim();
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(str)) return str;
        const hash = crypto.createHash('md5').update('muse_sess_' + str).digest('hex');
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      };

      let streamSessionId = normalizeSessionUUID(options.sessionId);
      if (!streamSessionId || options.new_session || options.isNewSession) {
        streamSessionId = crypto.randomUUID();
      }

      const finish = async (payload = {}, reason = 'unknown') => {
        if (isDone) return;
        isDone = true;
        console.log(`[MuseClient] finish() triggered by: "${reason}", fullResponse.len=${fullResponse.length}, text="${fullResponse.slice(0, 30)}..."`);
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
        cleanup(!aborted);
        if (aborted && streamSessionId) {
          const deleted = await this.deleteSession(streamSessionId).catch(() => null);
          if (!deleted?.ok) this.close();
          this.guardedSessions?.delete(streamSessionId);
        }

        // Fallback: If fullResponse is still empty for chat (not media-only), query /chat/history?session_id=
        if (!fullResponse && !options.waitForKind && streamSessionId && !aborted) {
          try {
            const histRes = await this.sendRequest('GET', `/chat/history?session_id=${streamSessionId}`, null, [], false);
            if (histRes.status === 200 && histRes.body) {
              const parsed = JSON.parse(histRes.body);
              const evs = parsed.result?.chat_events || [];
              const lastAssistant = evs.filter(e => e.role === 'assistant' || e.event_name === 'message.assistant').pop();
              const histText = lastAssistant?.display_text || lastAssistant?.payload?.content || '';
              if (histText) {
                fullResponse = histText;
                if (onToken) onToken(histText);
              }
            }
          } catch (e) {}
        }

        resolve({
          text: fullResponse,
          presentations,
          sessionId: streamSessionId,
          payload,
          aborted,
          abortInfo
        });
      };

      // ---- Chat Media Guard hooks -------------------------------------
      // options.onAbortCheck(type, payload) -> verdict|null is evaluated on
      // upstream signals only ('presentation', 'status', 'raw' events). A
      // truthy verdict ends the turn immediately ("policy_abort").
      let aborted = false;
      let abortInfo = null;
      const checkAbort = (type, payload) => {
        if (isDone || aborted || typeof options.onAbortCheck !== 'function') return;
        let verdict = null;
        try { verdict = options.onAbortCheck(type, payload); } catch (e) { verdict = null; }
        if (verdict) {
          aborted = true;
          abortInfo = typeof verdict === 'object' ? verdict : { reason: String(verdict) };
          finish({ aborted: true }, 'policy_abort');
        }
      };
      const emit = (type, payload) => {
        if (onEvent) {
          try { onEvent(type, payload); } catch (e) { /* listener errors must not break the turn */ }
        }
        checkAbort(type, payload);
      };
      if (options.guardEgress) {
        if (!this.guardedSessions) this.guardedSessions = new Set();
        this.guardedSessions.add(streamSessionId);
      }

      let latestActivityCode = 'unknown';
      let sessionCompleted = false;
      let lastActivityTime = Date.now();

      const isForSession = (p) => {
        const id = p?.session_id || p?.chat_context?.chat_id || p?.chat_id;
        return id === streamSessionId;
      };

      const handleDelta = (text, payload, seq) => {
        if (isDone || !isForSession(payload)) return;
        fullResponse += text;
        lastPolledText = fullResponse;
        if (onToken) onToken(text);
        lastActivityTime = Date.now();
        unchangedTicks = 0;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
      };

      const handlePresentation = (payload, seq) => {
        if (isDone || !isForSession(payload)) return;
        // Do not treat browser_task as a media presentation
        if (payload?.kind === 'browser_task' || payload?.data?.browser_task_id || !isCurrentMedia(payload)) return;

        presentations.push(payload);
        emit('presentation', payload);
        lastActivityTime = Date.now();
        unchangedTicks = 0;
        // If caller was waiting for this media kind, allow completion after graceful settle
        if (options.waitForKind && hasExpectedMedia()) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => finish(payload), 2500);
        }
      };

      const handleStatus = (payload, seq) => {
        if (isDone || !isForSession(payload)) return;
        emit('status', payload);

        const code = payload?.activity_code;
        if (code) latestActivityCode = code;
        lastActivityTime = Date.now();

        // While the AI agent is actively rendering or working, never prematurely cut it off!
        if (code === 'working' || code === 'making_something' || code === 'responding' || code === 'thinking' || code === 'running') {
          unchangedTicks = 0;
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
        }

        // When status is idle or online, do NOT cut off immediately (agent may be pausing between tools/steps).
        // Only schedule finish if session is explicitly completed and generous debounce passes.
        if ((code === 'online' || code === 'idle') && sessionCompleted) {
          if (hasTurnContent()) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              pollHistory().then(() => finish(payload, 'status_online_idle_debounce'));
            }, 3500);
          }
        }
      };

      const handleDone = (payload, seq) => {
        if (isDone || !isForSession(payload)) return;

        lastActivityTime = Date.now();

        // Extract assistant message from transcript if fullResponse is empty or shorter
        const assistantMsg = payload?.transcript?.messages?.find(m => m.role === 'assistant');
        const transcriptText = assistantMsg?.content?.map(c => c.text || '').join('');
        if (transcriptText && (!fullResponse || fullResponse.length < transcriptText.length)) {
          if (!fullResponse) {
            fullResponse = transcriptText;
            if (onToken) onToken(transcriptText);
          } else if (transcriptText.startsWith(fullResponse)) {
            const remaining = transcriptText.slice(fullResponse.length);
            fullResponse = transcriptText;
            if (onToken && remaining) onToken(remaining);
          }
        }

        // Extract any presentations from payload
        if (Array.isArray(payload?.presentations)) {
          for (const pres of payload.presentations) {
            if (isCurrentMedia(pres) && !presentations.some(p => (p.id && p.id === pres.id) || (p.image_path && p.image_path === pres.image_path))) {
              presentations.push(pres);
              emit('presentation', pres);
            }
          }
        }

        // Proactively check /chat/history for any updated tool outputs or additional messages
        pollHistory();

        // If caller was waiting for media generation (image/video) and it's ready, finish after debounce
        if (options.waitForKind && hasExpectedMedia()) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => finish(payload), 1500);
        }
      };

      let pollTimer = null;
      let unchangedTicks = 0;
      let lastPolledText = '';
      const callStartTime = Date.now();
      let polling = false;

      const pollHistory = async () => {
        if (isDone) {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          return;
        }
        if (polling) return;
        polling = true;
        try {
          const hRes = await this.sendRequest('GET', `/chat/history?session_id=${streamSessionId}`, null, [], false, null, { signal: options.signal });
          if (isDone) return;
          if (hRes.status === 200 && hRes.body) {
            const parsed = JSON.parse(hRes.body);
            const evs = parsed.result?.chat_events || [];
            
            // Find the LAST user message in this session
            const lastUserIdx = evs.map(e => e.role === 'user' || e.event_name === 'message.user').lastIndexOf(true);
            if (options.sessionId && options.waitForKind && lastUserIdx <= previousUserIndex) return;
            const turnEvents = lastUserIdx !== -1 ? evs.slice(lastUserIdx + 1) : evs;

            // Extract any presentations from ALL turn events (including delta.presentation)
            for (const evItem of turnEvents) {
              const p = evItem.payload || evItem;
              if (evItem.event_name === 'delta.presentation' || p.kind === 'image' || p.kind === 'video' || p.data?.images?.length > 0 || p.data?.videos?.length > 0) {
                if (isCurrentMedia(p) && !presentations.some(pr => (pr.id && pr.id === p.id) || (pr.image_path && pr.image_path === p.image_path) || (pr.data?.images?.[0]?.path && pr.data?.images?.[0]?.path === p.data?.images?.[0]?.path))) {
                  presentations.push(p);
                  emit('presentation', p);
                }
              }
              if (Array.isArray(p.presentations)) {
                for (const pres of p.presentations) {
                  if (isCurrentMedia(pres) && !presentations.some(pr => (pr.id && pr.id === pres.id) || (pr.image_path && pr.image_path === pres.image_path))) {
                    presentations.push(pres);
                    emit('presentation', pres);
                  }
                }
              }
            }

            // Combine text from actual assistant messages in this turn (exclude tool presentations & browser tasks)
            const assistantEvents = turnEvents.filter(e => 
              (e.role === 'assistant' || e.event_name === 'message.assistant') &&
              e.event_name !== 'delta.presentation' &&
              e.kind !== 'browser_task' &&
              e.payload?.kind !== 'browser_task' &&
              !e.data?.browser_task_id
            );
            const textBlocks = [];
            for (const aEv of assistantEvents) {
              const t = aEv.display_text || aEv.payload?.content || '';
              if (t && t.trim() && !textBlocks.includes(t)) {
                textBlocks.push(t);
              }
            }
            const currentTurnText = textBlocks.join('\n\n');

            if (currentTurnText) {
              // Stream progressive delta tokens to user in real time!
              if (currentTurnText.length > fullResponse.length) {
                if (currentTurnText.startsWith(fullResponse)) {
                  const delta = currentTurnText.slice(fullResponse.length);
                  fullResponse = currentTurnText;
                  if (onToken && delta) onToken(delta);
                } else if (!fullResponse) {
                  fullResponse = currentTurnText;
                  if (onToken) onToken(currentTurnText);
                } else if (currentTurnText.includes(fullResponse)) {
                  const idx = currentTurnText.indexOf(fullResponse);
                  const delta = currentTurnText.slice(idx + fullResponse.length);
                  fullResponse = currentTurnText;
                  if (onToken && delta) onToken(delta);
                } else {
                  // Suffix / prefix overlap matching to prevent duplicate tokens
                  let maxOverlap = 0;
                  const maxPossible = Math.min(fullResponse.length, currentTurnText.length);
                  for (let i = maxPossible; i > 0; i--) {
                    if (fullResponse.endsWith(currentTurnText.slice(0, i))) {
                      maxOverlap = i;
                      break;
                    }
                  }
                  const delta = currentTurnText.slice(maxOverlap);
                  if (delta) {
                    fullResponse += delta;
                    if (onToken) onToken(delta);
                  }
                }
                unchangedTicks = 0;
                lastPolledText = currentTurnText;
                lastActivityTime = Date.now();
              }

              const hasActiveToolTask = turnEvents.some(ev => {
                const p = ev.payload || ev;
                const d = p.data || ev.data;
                const s = (d?.status || p.status || '').toLowerCase();
                const ds = (d?.display_state || d?.display_status || '').toLowerCase();
                return s === 'running' || s === 'queued' || s === 'in_progress' || ds === 'working' || ds === 'starting';
              });

              if (currentTurnText.length > 0 && currentTurnText === lastPolledText) {
                const isAgentWorking = hasActiveToolTask ||
                                       latestActivityCode === 'working' ||
                                       latestActivityCode === 'making_something' ||
                                       latestActivityCode === 'responding' ||
                                       latestActivityCode === 'thinking' ||
                                       latestActivityCode === 'running';
                if (!isAgentWorking) {
                  unchangedTicks++;
                } else {
                  unchangedTicks = 0;
                  if (debounceTimer) {
                    clearTimeout(debounceTimer);
                    debounceTimer = null;
                  }
                }
              }

              // Check completion state
              const lastAssistant = assistantEvents[assistantEvents.length - 1];
              const isAssistantCompleted = lastAssistant?.status === 'completed' || lastAssistant?.payload?.status === 'completed';
              const isAllCompleted = (sessionCompleted || isAssistantCompleted) && !hasActiveToolTask;

              // Required quiet ticks: 12 ticks (4.8s) if explicitly marked completed, 25 ticks (10.0s) if waiting on silence
              const requiredTicks = isAllCompleted ? 12 : 25;

              if (hasTurnContent() && !hasActiveToolTask) {
                if (unchangedTicks >= requiredTicks) {
                  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                  finish(lastAssistant?.payload || {}, 'pollHistory_unchangedTicks_' + unchangedTicks);
                }
              }
            } else if (options.waitForKind && hasExpectedMedia() && presentations.length > 0) {
              // Media presentation is ready even before/without separate assistant text
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              finish({}, 'pollHistory_waitForKind_presentation');
            }
          }
        } catch (e) {} finally { polling = false; }
      };

      const handleAnyEvent = (ev) => {
        if (isDone) return;
        const sId = ev?.session_id || ev?.payload?.session_id || ev?.payload?.chat_context?.chat_id;
        if (!sId || sId === streamSessionId) checkAbort('raw', ev);
        if (!sId || sId === streamSessionId) {
          if (ev?.event === 'approvals.snapshot' || ev?.event?.startsWith('task.') || ev?.event?.includes('approval')) {
            lastActivityTime = Date.now();
            unchangedTicks = 0;
            if (debounceTimer) {
              clearTimeout(debounceTimer);
              debounceTimer = null;
            }
          }
        }
        if (sId === streamSessionId) {
          lastActivityTime = Date.now();
          if (ev?.event === 'sessions.updated') {
            const sess = ev.payload?.session;
            const change = ev.payload?.change;
            if (sess) {
              if (sess.status === 'completed' && change !== 'created') {
                sessionCompleted = true;
                pollHistory();
              } else if (sess.status === 'running') {
                sessionCompleted = false;
                if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
                unchangedTicks = 0;
                pollHistory();
              }
            }
          }
        }
      };

      // Start proactive history polling after 300ms, every 400ms for continuous streaming & media check
      setTimeout(() => {
        if (isDone) return;
        pollHistory();
        pollTimer = setInterval(pollHistory, 400);
      }, 300);

      const cleanup = (clearGuard = true) => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
        this.off('text_delta', handleDelta);
        this.off('presentation', handlePresentation);
        this.off('agent_status', handleStatus);
        this.off('message_done', handleDone);
        this.off('event', handleAnyEvent);
        this.off('close', handleClose);
        options.signal?.removeEventListener('abort', handleAbort);
        if (clearGuard && this.guardedSessions && streamSessionId) this.guardedSessions.delete(streamSessionId);
      };

      const fail = async (err) => {
        if (isDone) return;
        isDone = true;
        cleanup(false);
        // Session deletion stops this turn without closing other sessions.
        if (streamSessionId && this.ws?.readyState === 1) {
          const deleted = await this.deleteSession(streamSessionId).catch(() => null);
          if (!deleted?.ok) this.close();
        }
        this.guardedSessions?.delete(streamSessionId);
        reject(err);
      };
      const handleAbort = () => { fail(options.signal.reason || new Error('Chat session aborted.')); };
      const handleClose = () => { fail(new Error('Upstream socket closed during chat.')); };

      this.on('text_delta', handleDelta);
      this.on('presentation', handlePresentation);
      this.on('agent_status', handleStatus);
      this.on('message_done', handleDone);
      this.on('event', handleAnyEvent);
      this.on('close', handleClose);
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      if (options.signal?.aborted) { handleAbort(); return; }

      // Adaptive timeout: 300s (5m) for video, 180s (3m) for image and chat
      const defaultTimeout = options.waitForKind === 'video' ? 300000 : 180000;
      const timeoutMs = options.timeout || defaultTimeout;
      overallTimer = setTimeout(() => {
        const targetName = options.waitForKind === 'video' ? 'Video generation' : (options.waitForKind === 'image' ? 'Image generation' : 'Chat session');
        fail(new Error(`${targetName} timed out after ${timeoutMs / 1000}s. Please retry.`));
      }, timeoutMs);

      const items = [];

      // 1. Process Reference Image if provided
      if (options.ref_image || options.refImage) {
        const ref = options.ref_image || options.refImage;
        const b64 = typeof ref === 'string'
          ? (ref.includes(';base64,') ? ref.split(';base64,')[1] : ref)
          : (ref.data_base64 || (Buffer.isBuffer(ref.buffer) ? ref.buffer.toString('base64') : ''));
        const mime = (typeof ref === 'object' && (ref.mime_type || ref.mime)) || 'image/jpeg';
        if (b64) {
          items.push({
            type: 'image',
            mime_type: mime,
            data_base64: b64
          });
        }
      }

      // 2. Process Reference Video / File if provided
      if (options.ref_video || options.refVideo) {
        const ref = options.ref_video || options.refVideo;
        const b64 = typeof ref === 'string'
          ? (ref.includes(';base64,') ? ref.split(';base64,')[1] : ref)
          : (ref.data_base64 || (Buffer.isBuffer(ref.buffer) ? ref.buffer.toString('base64') : ''));
        const mime = (typeof ref === 'object' && (ref.mime_type || ref.mime)) || 'video/mp4';
        const filename = (typeof ref === 'object' && ref.filename) || 'reference_video.mp4';
        if (b64) {
          items.push({
            type: 'file',
            mime_type: mime,
            data_base64: b64,
            filename: filename
          });
        }
      }

      // 3. Merge custom items if provided
      if (Array.isArray(options.items)) {
        for (const it of options.items) {
          if (!items.some(ex => ex.data_base64 && ex.data_base64 === it.data_base64)) {
            items.push(it);
          }
        }
      }

      // 4. Append prompt text
      if (prompt && prompt.trim()) {
        items.push({ type: 'text', text: prompt.trim() });
      }

      const requestPayload = {
        items,
        node_id: this.deviceId,
        session_id: streamSessionId,
        capabilities: [
          'chat_cancel',
          'delta_stream'
        ]
      };

      (async () => { try {
        const streamRes = await this.sendRequest('POST', '/chat/stream', requestPayload, [], true, null, { signal: options.signal });
        if (streamRes.body) {
          try {
            const parsed = JSON.parse(streamRes.body);
            if (parsed.session_id) {
              streamSessionId = parsed.session_id;
            }
          } catch (e) {}
        }
      } catch (err) {
        await fail(err);
      } })();
    });
  }

  /**
   * Specialized Image Generation with optional reference image / media
   */
  async generateImage(prompt, options = {}) {
    const onProgress = options.onProgress;
    const download = options.download !== false; // default true
    const refImage = options.ref_image || options.refImage || null;
    const refVideo = options.ref_video || options.refVideo || null;

    const aspectRatio = options.aspect_ratio || options.aspectRatio;
    const ratioHint = aspectRatio ? ` (aspect ratio ${aspectRatio})` : '';

    let formattedPrompt = `Generate an image: ${prompt}${ratioHint}`;
    if (refImage) {
      formattedPrompt = `Using the attached reference image, generate a new image that follows this request: ${prompt}${ratioHint}`;
    } else if (refVideo) {
      formattedPrompt = `Using the attached reference video, generate a new image that follows this request: ${prompt}${ratioHint}`;
    }

    const chatResult = await this.chat(formattedPrompt, {
      sessionId: options.sessionId || null,
      new_session: !options.sessionId,
      ref_image: refImage,
      ref_video: refVideo,
      timeout: options.timeout || 180000,
      waitForKind: 'image',
      signal: options.signal,
      onEvent: (type, payload) => {
        if (type === 'status' && onProgress) {
          onProgress(payload.activity_text || payload.activity_code);
        }
      }
    });

    // Find image presentation widget
    const imagePres = chatResult.presentations.find(p => p.kind === 'image' || p.data?.images?.length > 0);
    if (!imagePres) {
      if (chatResult.sessionId && !options.retainSession) this.deleteSession(chatResult.sessionId).catch(() => {});
      return {
        success: false,
        text: chatResult.text,
        error: 'The model did not produce an image for this request.'
      };
    }

    const imgInfo = imagePres.data?.images?.[0] || {};
    const imgPath = imagePres.image_path || imgInfo.path;

    let base64 = null;
    let buffer = null;
    try {
      options.signal?.throwIfAborted();
      if (download && imgPath) {
        if (onProgress) onProgress('Downloading image...');
        buffer = await this.readFile(imgPath, options.maxBytes, { signal: options.signal });
        base64 = buffer.toString('base64');
      }
    } finally {
      if (chatResult.sessionId && !options.retainSession) await this.deleteSession(chatResult.sessionId).catch(() => {});
    }

    return {
      success: true,
      sessionId: chatResult.sessionId,
      text: chatResult.text,
      prompt,
      path: imgPath,
      mimeType: imgInfo.mime || 'image/webp',
      byteLen: imgInfo.byte_len || buffer?.length || 0,
      buffer,
      base64
    };
  }

  /**
   * Specialized Video Generation with optional reference image (Image-to-Video) or video (Video-to-Video)
   */
  async generateVideo(prompt, options = {}) {
    const onProgress = options.onProgress;
    const download = options.download !== false; // default true
    const refImage = options.ref_image || options.refImage || null;
    const refVideo = options.ref_video || options.refVideo || null;
    const aspectRatio = options.aspect_ratio || options.aspectRatio || '16:9';
    const duration = parseInt(options.duration, 10) || 5;

    let formattedPrompt = `Create a high quality motion video based on this prompt: "${prompt}". Aspect ratio: ${aspectRatio}, duration: ${duration}s. Generate the video now.`;
    if (refImage) {
      formattedPrompt = `Based on the attached reference image (Image-to-Video), create a smooth motion video: "${prompt}". Aspect ratio: ${aspectRatio}, duration: ${duration}s.`;
    } else if (refVideo) {
      formattedPrompt = `Based on the attached reference video (Video-to-Video), regenerate a motion video with dynamic effects: "${prompt}". Aspect ratio: ${aspectRatio}, duration: ${duration}s.`;
    }

    const chatResult = await this.chat(formattedPrompt, {
      sessionId: options.sessionId || null,
      new_session: !options.sessionId,
      ref_image: refImage,
      ref_video: refVideo,
      timeout: options.timeout || 180000,
      waitForKind: 'video',
      signal: options.signal,
      onEvent: (type, payload) => {
        if (type === 'status' && onProgress) {
          onProgress(payload.activity_text || payload.activity_code);
        }
      }
    });

    // 1. Find video presentation widget
    const videoPres = chatResult.presentations.find(p => p.kind === 'video' || p.data?.videos?.length > 0);
    let vidInfo = videoPres?.data?.videos?.[0] || {};
    let vidPath = vidInfo.path || videoPres?.data?.fallback_text?.match(/sandbox:\/\/([^\)]+)/)?.[1] || null;

    // Only this session's presentation/history may identify an output file.

    if (!vidPath) {
      if (chatResult.sessionId && !options.retainSession) await this.deleteSession(chatResult.sessionId).catch(() => {});
      return {
        success: false,
        text: chatResult.text,
        error: 'The model did not produce a video for this request. Try again with a more specific prompt.'
      };
    }

    let base64 = null;
    let buffer = null;
    try {
      options.signal?.throwIfAborted();
      if (download && vidPath) {
        if (onProgress) onProgress('Downloading video...');
        buffer = await this.readFile(vidPath, options.maxBytes, { signal: options.signal });
        base64 = buffer.toString('base64');
      }
    } finally {
      if (chatResult.sessionId && !options.retainSession) await this.deleteSession(chatResult.sessionId).catch(() => {});
    }

    return {
      success: true,
      sessionId: chatResult.sessionId,
      text: chatResult.text,
      prompt,
      path: vidPath,
      mimeType: vidInfo.mime || 'video/mp4',
      byteLen: vidInfo.byte_len || buffer?.length || 0,
      buffer,
      base64
    };
  }

  /**
   * List all sessions / threads currently recorded on Meta VM
   * @returns {Promise<Array>} List of session objects
   */
  async listSessions() {
    const res = await this.sendRequest('GET', '/api/session/list');
    if (res.status !== 200) {
      throw new Error(`Failed to list sessions: HTTP ${res.status} ${res.body}`);
    }
    const data = JSON.parse(res.body);
    return data.result?.sessions || [];
  }

  /**
   * Delete a secondary chat thread on Meta VM via WebSocket Noise
   * @param {string} sessionId UUID of the chat session
   */
  async deleteSession(sessionId) {
    if (!sessionId) return { ok: false, message: 'Missing session_id' };
    try {
      const res = await this.sendRequest('POST', '/session/delete', {
        method: '/api/session/delete',
        session_id: sessionId
      });
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        return { ok: true, deleted: !!data.result?.deleted, result: data.result };
      }
      return { ok: false, status: res.status, body: res.body };
    } catch (err) {
      console.warn(`[MuseClient] Failed to delete session ${sessionId} on Meta:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Delete all secondary threads on Meta server (leaving only the primary chat)
   */
  async deleteAllSecondarySessions() {
    try {
      const sessions = await this.listSessions();
      const secondarySessions = sessions.filter(s => s.is_thread && !s.is_primary);
      const results = [];
      for (const s of secondarySessions) {
        const delRes = await this.deleteSession(s.session_id);
        results.push({ session_id: s.session_id, title: s.title || s.snippet, ...delRes });
      }
      return { ok: true, total: secondarySessions.length, results };
    } catch (err) {
      console.warn('[MuseClient] Failed to deleteAllSecondarySessions:', err.message);
      return { ok: false, error: err.message };
    }
  }

  close() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this.pendingStreams && this.pendingStreams.size > 0) {
      for (const [sId, stream] of this.pendingStreams.entries()) {
        try { stream.reject(new Error('The upstream client connection was closed.')); } catch (e) {}
      }
      this.pendingStreams.clear();
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }

  disconnect() {
    return this.close();
  }
}

/**
 * Automatically fetch a fresh WebSocket URL from muse.ai using only a cookie string.
 * Returns { success, wsUrl, expiry, vmId, refreshedCookies, hybrid }
 */
async function fetchWssFromCookie(cookieString, proxy = null, options = {}) {
  if (!cookieString || typeof cookieString !== 'string') {
    throw new Error('Cookie is empty or invalid.');
  }
  const clean = extractCookie(cookieString) || cookieString;
  if (!clean.includes('hatch_sess=')) {
    throw new Error('Invalid cookie: it must contain hatch_sess=... (upstream login session).');
  }

  const { extractWssViaChromium, detectChromium } = require('./browser');
  const hasChromium = Boolean(detectChromium());

  // 1. If explicit browser preference requested AND Chromium is available, attempt Chromium first
  if ((options.preferBrowser || options.useBrowser) && hasChromium) {
    try {
      console.log('[Bootstrap] Preferred browser extraction: launching Chromium...');
      return await extractWssViaChromium(clean, { proxy, ...options });
    } catch (browserErr) {
      console.warn(`[Bootstrap] Preferred browser extraction failed (${browserErr.message}). Falling back to HTTP probe...`);
    }
  }

  // 2. Try fast HTTP probe
  let httpErr = null;
  try {
    const probe = new MuseClient({ cookies: clean, proxy });
    probe.forceRefresh = true;
    const wsUrl = await probe.bootstrap();
    const expiry = getWssExpiry(wsUrl);
    let vmId = null;
    try {
      vmId = new URL(wsUrl).searchParams.get('vm_id');
    } catch (e) {}
    const refreshedCookies = probe.refreshedCookies || clean;
    return {
      success: true,
      wsUrl,
      expiry,
      vmId,
      refreshedCookies,
      hybrid: buildHybrid(wsUrl, refreshedCookies),
      extractedVia: 'http'
    };
  } catch (err) {
    httpErr = err;
    if (err.code === 'MUSE_AUTH_EXPIRED') {
      throw err;
    }
  }

  // 3. Fallback to Chromium browser automation if HTTP failed (and wasn't already tried above)
  if (hasChromium && !(options.preferBrowser || options.useBrowser)) {
    try {
      console.log('[Bootstrap] HTTP probe failed. Falling back to Chromium browser automation...');
      return await extractWssViaChromium(clean, { proxy, ...options });
    } catch (browserErr) {
      throw new Error(`Failed to extract WebSocket URL from cookie via HTTP (${httpErr?.message || 'failed'}) and Chromium browser (${browserErr.message}).`);
    }
  }

  // 4. If browser was explicitly requested but Chromium is not detected and HTTP also failed
  if ((options.preferBrowser || options.useBrowser) && !hasChromium) {
    throw new Error(
      `Chromium browser was requested but is not installed on this system, and HTTP extraction failed: ${httpErr?.message || 'Upstream session error'}`
    );
  }

  throw httpErr;
}

module.exports = {
  MuseClient,
  fetchWssFromCookie
};
