"use strict";

const express = require("express");
const cheerio = require("cheerio");
const http = require("http");
const net = require("net");
const tls = require("tls");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const RAW_LIMIT = process.env.RAW_LIMIT || "200mb";
const STREAM_GATEWAY_PATH = "/api/gateway/proxy";
const WS_GATEWAY_PATH = "/api/gateway/ws";

const BLOCKED_TRACKERS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "adservice.google.com",
  "facebook.net",
  "connect.facebook.net",
  "segment.io",
  "hotjar.com",
  "mixpanel.com",
  "newrelic.com",
  "datadoghq.com",
  "sentry.io",
  "clarity.ms",
  "scorecardresearch.com",
  "taboola.com",
  "outbrain.com"
];

const STRIP_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "frame-options",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy"
]);

const CLOAKING_SCRIPT = `(function(){
  try {
    const define = (obj, key, value) => {
      Object.defineProperty(obj, key, {
        configurable: false,
        enumerable: true,
        get: () => value
      });
    };

    define(Navigator.prototype, 'webdriver', false);
    define(Navigator.prototype, 'platform', 'Win32');
    define(Navigator.prototype, 'language', 'en-US');
    define(Navigator.prototype, 'languages', Object.freeze(['en-US', 'en']));
    define(Navigator.prototype, 'vendor', 'Google Inc.');
    define(Navigator.prototype, 'hardwareConcurrency', 8);
    define(Navigator.prototype, 'deviceMemory', 8);

    const RealDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locale, options){
      const formatter = new RealDateTimeFormat(locale || 'en-US', {
        ...(options || {}),
        timeZone: 'UTC'
      });
      const nativeResolved = formatter.resolvedOptions.bind(formatter);
      formatter.resolvedOptions = function(){
        const result = nativeResolved();
        return Object.freeze({ ...result, timeZone: 'UTC', locale: 'en-US' });
      };
      return formatter;
    };

    Intl.DateTimeFormat.prototype = RealDateTimeFormat.prototype;
    Object.freeze(Intl.DateTimeFormat.prototype);
  } catch (_) {}
})();`;

app.disable("x-powered-by");
app.set("etag", false);

app.use(express.json({ limit: "2mb" }));
app.use(
  express.raw({
    limit: RAW_LIMIT,
    type: (req) => {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      return !contentType.includes("application/json");
    }
  })
);

function encodeBase64Utf8(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function decodeBase64Utf8(input) {
  if (!input || typeof input !== "string") return "";

  const normalized = String(input)
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const missingPadding = normalized.length % 4;
  const padded = missingPadding === 0 ? normalized : normalized + "=".repeat(4 - missingPadding);

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function normalizeDestinationUrl(input, wsMode = false) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate) && !/^wss?:\/\//i.test(candidate)) {
    candidate = wsMode ? `wss://${candidate}` : `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (!wsMode && protocol !== "http:" && protocol !== "https:") return null;
    if (wsMode && protocol !== "ws:" && protocol !== "wss:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return BLOCKED_TRACKERS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function toProxyUrl(absoluteUrl) {
  return `${STREAM_GATEWAY_PATH}?url=${encodeURIComponent(encodeBase64Utf8(absoluteUrl))}`;
}

function toWebSocketProxyUrl(absoluteWsUrl) {
  return `${WS_GATEWAY_PATH}?url=${encodeURIComponent(absoluteWsUrl)}`;
}

function absolutize(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function rewriteEmbeddedUrlsInText(text, baseUrl) {
  if (!text || typeof text !== "string") return text;

  const rewriteAbsolute = (match) => {
    try {
      const u = new URL(match);
      if (u.protocol === "http:" || u.protocol === "https:") return toProxyUrl(u.toString());
      if (u.protocol === "ws:" || u.protocol === "wss:") return toWebSocketProxyUrl(u.toString());
      return match;
    } catch {
      return match;
    }
  };

  let output = text;
  output = output.replace(/https?:\/\/[^\s"'`<>\\)]+/gi, rewriteAbsolute);
  output = output.replace(/wss?:\/\/[^\s"'`<>\\)]+/gi, rewriteAbsolute);

  output = output.replace(/(["'`])(\/[^"]*?)\1/g, (full, q, relPath) => {
    const resolved = absolutize(relPath, baseUrl);
    if (!resolved) return full;
    return `${q}${toProxyUrl(resolved)}${q}`;
  });

  return output;
}

function rewriteJsonDeep(value, baseUrl) {
  if (typeof value === "string") return rewriteEmbeddedUrlsInText(value, baseUrl);
  if (Array.isArray(value)) return value.map((entry) => rewriteJsonDeep(entry, baseUrl));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewriteJsonDeep(v, baseUrl);
    }
    return out;
  }
  return value;
}

function rewriteHtmlDocument(html, baseUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const rewriteAttribute = (selector, attribute) => {
    $(selector).each((_, el) => {
      const current = $(el).attr(attribute);
      if (!current || current.startsWith("#") || current.startsWith("data:")) return;
      const absolute = absolutize(current, baseUrl);
      if (!absolute) return;
      const protocol = new URL(absolute).protocol;
      if (protocol === "http:" || protocol === "https:") {
        $(el).attr(attribute, toProxyUrl(absolute));
      } else if (protocol === "ws:" || protocol === "wss:") {
        $(el).attr(attribute, toWebSocketProxyUrl(absolute));
      }
    });
  };

  rewriteAttribute("a[href]", "href");
  rewriteAttribute("link[href]", "href");
  rewriteAttribute("script[src]", "src");
  rewriteAttribute("img[src]", "src");
  rewriteAttribute("iframe[src]", "src");
  rewriteAttribute("video[src]", "src");
  rewriteAttribute("audio[src]", "src");
  rewriteAttribute("source[src]", "src");
  rewriteAttribute("form[action]", "action");
  rewriteAttribute("object[data]", "data");
  rewriteAttribute("embed[src]", "src");

  $("a[target], form[target]").each((_, el) => {
    const target = String($(el).attr("target") || "").toLowerCase();
    if (target === "_top" || target === "_parent") {
      $(el).attr("target", "_self");
    }
  });

  $("img[srcset], source[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (!srcset) return;
    const rewritten = srcset
      .split(",")
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (!parts[0]) return entry;
        const absolute = absolutize(parts[0], baseUrl);
        if (!absolute) return entry;
        parts[0] = toProxyUrl(absolute);
        return parts.join(" ");
      })
      .join(", ");
    $(el).attr("srcset", rewritten);
  });

  $("script:not([src])").each((_, el) => {
    const source = $(el).html() || "";
    const rewritten = rewriteEmbeddedUrlsInText(source, baseUrl);
    if (rewritten !== source) {
      $(el).text(rewritten);
    }
  });

  $("[style]").each((_, el) => {
    const styleValue = $(el).attr("style") || "";
    $(el).attr("style", rewriteEmbeddedUrlsInText(styleValue, baseUrl));
  });

  let head = $("head");
  if (head.length === 0) {
    if ($("html").length === 0) {
      $.root().prepend("<html><head></head><body></body></html>");
    } else {
      $("html").prepend("<head></head>");
    }
    head = $("head");
  }

  head.prepend(`<script>${CLOAKING_SCRIPT}</script>`);

  return $.html();
}

function cleanSetCookie(cookieValue) {
  return String(cookieValue)
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*SameSite=None/gi, "")
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*Path=[^;]*/gi, "; Path=/")
    .replace(/;\s{2,}/g, "; ")
    .trim();
}

function isYouTubeLikeHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host.includes("googlevideo.com") ||
    host.includes("ytimg.com") ||
    host.includes("youtube.com") ||
    host.includes("youtubei.googleapis.com")
  );
}

function hasRangeHeader(reqHeaders) {
  const range = String(reqHeaders.range || "").toLowerCase();
  return range.startsWith("bytes=");
}

function shouldBypassForMedia(urlObj, reqHeaders, responseContentType) {
  const host = String(urlObj.hostname || "").toLowerCase();
  const pathname = String(urlObj.pathname || "").toLowerCase();
  const search = String(urlObj.search || "").toLowerCase();
  const accept = String(reqHeaders.accept || "").toLowerCase();
  const secFetchDest = String(reqHeaders["sec-fetch-dest"] || "").toLowerCase();
  const contentType = String(responseContentType || "").toLowerCase();

  const youtubeHost = isYouTubeLikeHost(host);
  const youtubeChunkPath =
    pathname.includes("videoplayback") ||
    pathname.includes("/initplayback") ||
    pathname.includes("/generate_204") ||
    pathname.includes("/api/stats") ||
    pathname.includes("/youtubei/") ||
    pathname.includes("/player") ||
    pathname.includes("/stream") ||
    pathname.endsWith(".m3u8") ||
    pathname.endsWith(".mpd") ||
    pathname.endsWith(".ts") ||
    pathname.endsWith(".mp4") ||
    pathname.endsWith(".webm") ||
    pathname.endsWith(".m4s") ||
    search.includes("mime=video") ||
    search.includes("source=youtube");

  const binaryType =
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    contentType.includes("application/dash+xml");

  const mediaDestination =
    secFetchDest === "video" ||
    secFetchDest === "audio" ||
    secFetchDest === "track" ||
    accept.includes("video/") ||
    accept.includes("audio/");

  if (youtubeHost && (youtubeChunkPath || hasRangeHeader(reqHeaders) || mediaDestination || binaryType)) {
    return true;
  }

  return binaryType || mediaDestination;
}

function cloneRequestHeadersForTarget(req, targetUrl) {
  const cloned = {};

  for (const [key, value] of Object.entries(req.headers || {})) {
    if (typeof value === "undefined") continue;
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "origin" ||
      lower === "referer" ||
      lower === "content-length" ||
      lower === "accept-encoding"
    ) {
      continue;
    }
    cloned[key] = value;
  }

  cloned.host = targetUrl.host;
  cloned.origin = targetUrl.origin;
  cloned.referer = `${targetUrl.origin}/`;
  cloned["x-forwarded-host"] = req.headers.host || "";
  cloned["x-forwarded-proto"] = req.protocol || "http";

  if (isYouTubeLikeHost(targetUrl.hostname) && req.headers.range) {
    cloned.range = req.headers.range;
  }

  return cloned;
}

function copyResponseHeaders(downstreamRes, upstreamHeaders, preserveContentLength) {
  for (const [header, value] of upstreamHeaders.entries()) {
    const lower = header.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) continue;
    if (lower === "set-cookie") continue;
    if (!preserveContentLength && lower === "content-length") continue;
    downstreamRes.setHeader(header, value);
  }

  const cookies = typeof upstreamHeaders.getSetCookie === "function" ? upstreamHeaders.getSetCookie() : [];
  if (cookies.length > 0) {
    downstreamRes.setHeader("set-cookie", cookies.map(cleanSetCookie));
  } else {
    const single = upstreamHeaders.get("set-cookie");
    if (single) downstreamRes.setHeader("set-cookie", cleanSetCookie(single));
  }
}

async function pipeWebStreamToExpress(webBody, downstreamRes) {
  if (!webBody) {
    downstreamRes.end();
    return;
  }

  const reader = webBody.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!downstreamRes.write(Buffer.from(value))) {
        await new Promise((resolve) => downstreamRes.once("drain", resolve));
      }
    }
  } finally {
    downstreamRes.end();
  }
}

app.get("/api/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "toxic-network-hub-sandbox-interface" });
});

app.post("/api/ai/chat", (req, res) => {
  const message = String(req.body?.message || "").trim().toLowerCase();

  const mappings = [
    {
      test: /status|health|online|running|uptime/,
      response:
        "Toxic Network Hub - Sandbox Interface is online. NDSP rewriting, isolation routing, and binary stream passthrough are active."
    },
    {
      test: /config|configuration|headers|security|csp|frame/,
      response:
        "Current configuration clones compatible request headers, strips restrictive frame/CSP headers, and normalizes cookie scope for sandbox continuity."
    },
    {
      test: /route|gateway|proxy|stream-harness|search/,
      response:
        "Submit any URL from the search field. It is Base64-encoded in the client and sent to /api/gateway/proxy?url=..., where it is decoded and rewritten for isolated navigation."
    },
    {
      test: /youtube|media|video|range|buffer/,
      response:
        "Media compatibility mode preserves byte-range behavior and streams video/audio chunks directly without HTML parsing to reduce buffering and parser stalls."
    }
  ];

  const matched = mappings.find((entry) => entry.test.test(message));
  const response =
    matched?.response ||
    "Toxic Network Hub - Sandbox Interface provides browser isolation, NDSP link remapping, and resilient media stream passthrough for educational routing tests.";

  res.status(200).json({ ok: true, response });
});

app.all("/api/gateway/proxy", async (req, res) => {
  const encodedToken = String(req.query.url || "").trim();
  const decodedUrl = decodeBase64Utf8(encodedToken);
  const targetUrl = normalizeDestinationUrl(decodedUrl, false);

  if (!targetUrl) {
    res.status(400).json({ ok: false, error: "Invalid destination URL" });
    return;
  }

  if (isBlockedHost(targetUrl.hostname)) {
    res.status(451).json({ ok: false, error: "Request blocked by telemetry firewall" });
    return;
  }

  const upstreamHeaders = cloneRequestHeadersForTarget(req, targetUrl);
  const method = req.method.toUpperCase();
  const includeBody = !["GET", "HEAD"].includes(method);

  const fetchInit = {
    method,
    headers: upstreamHeaders,
    redirect: "manual"
  };

  if (includeBody && req.body && req.body.length > 0) {
    fetchInit.body = req.body;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), fetchInit);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "Upstream request failed",
      detail: String(error?.message || error)
    });
    return;
  }

  const responseContentType = String(upstreamResponse.headers.get("content-type") || "");
  const isHtml = responseContentType.toLowerCase().includes("text/html");
  const isJson = responseContentType.toLowerCase().includes("application/json");
  const isJavaScript =
    responseContentType.toLowerCase().includes("application/javascript") ||
    responseContentType.toLowerCase().includes("text/javascript") ||
    responseContentType.toLowerCase().includes("application/x-javascript");

  const bypassMedia = shouldBypassForMedia(targetUrl, req.headers, responseContentType);
  const willRewrite = isHtml || isJson || isJavaScript;

  copyResponseHeaders(res, upstreamResponse.headers, bypassMedia || !willRewrite);
  res.status(upstreamResponse.status);

  if (bypassMedia || !willRewrite) {
    await pipeWebStreamToExpress(upstreamResponse.body, res);
    return;
  }

  if (isHtml) {
    const source = await upstreamResponse.text();
    const rewritten = rewriteHtmlDocument(source, targetUrl.toString());
    res.type("text/html; charset=utf-8").send(rewritten);
    return;
  }

  if (isJson) {
    const source = await upstreamResponse.text();
    try {
      const parsed = JSON.parse(source);
      const rewrittenJson = rewriteJsonDeep(parsed, targetUrl.toString());
      res.type("application/json").send(JSON.stringify(rewrittenJson));
    } catch {
      res.type("application/json").send(rewriteEmbeddedUrlsInText(source, targetUrl.toString()));
    }
    return;
  }

  if (isJavaScript) {
    const source = await upstreamResponse.text();
    const rewrittenJs = rewriteEmbeddedUrlsInText(source, targetUrl.toString());
    res.type("application/javascript").send(rewrittenJs);
    return;
  }

  await pipeWebStreamToExpress(upstreamResponse.body, res);
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route for ${req.method} ${req.path}` });
});

function buildWebSocketHandshake(req, targetUrl) {
  const requestPath = `${targetUrl.pathname || "/"}${targetUrl.search || ""}`;
  const headers = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${targetUrl.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade"
  ];

  const passThroughHeaders = [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
    "cookie",
    "user-agent",
    "accept-language",
    "cache-control",
    "pragma"
  ];

  for (const header of passThroughHeaders) {
    const value = req.headers[header];
    if (typeof value !== "undefined") {
      headers.push(`${header}: ${Array.isArray(value) ? value.join("; ") : value}`);
    }
  }

  headers.push(`Origin: ${targetUrl.origin}`);
  headers.push(`Referer: ${targetUrl.origin}/`);
  headers.push("\r\n");

  return headers.join("\r\n");
}

server.on("upgrade", (req, clientSocket, head) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    clientSocket.destroy();
    return;
  }

  if (requestUrl.pathname !== WS_GATEWAY_PATH) {
    clientSocket.destroy();
    return;
  }

  const rawTarget = requestUrl.searchParams.get("url") || "";
  const targetUrl = normalizeDestinationUrl(rawTarget, true);

  if (!targetUrl || isBlockedHost(targetUrl.hostname)) {
    clientSocket.write("HTTP/1.1 451 Unavailable For Legal Reasons\r\nConnection: close\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const port = Number(targetUrl.port || (targetUrl.protocol === "wss:" ? 443 : 80));
  const connectSocket = targetUrl.protocol === "wss:" ? tls.connect : net.connect;

  const upstreamSocket = connectSocket(
    {
      host: targetUrl.hostname,
      port,
      servername: targetUrl.hostname
    },
    () => {
      const handshake = buildWebSocketHandshake(req, targetUrl);
      upstreamSocket.write(handshake);
      if (head && head.length > 0) upstreamSocket.write(head);
    }
  );

  upstreamSocket.on("error", () => {
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      clientSocket.destroy();
    }
  });

  clientSocket.on("error", () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });

  upstreamSocket.pipe(clientSocket);
  clientSocket.pipe(upstreamSocket);
});

server.listen(PORT, () => {
  console.log(`Toxic Network Hub - Sandbox Interface listening on port ${PORT}`);
});
