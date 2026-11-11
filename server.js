import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const ROOT_DOMAIN = String(process.env.ROOT_DOMAIN || "is-aroace.l.cd")
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, "")
  .replace(/\/+$/, "")
  .replace(/\.$/, "");
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 25 * 1024 * 1024);
const EDGE_FUNCTION_TIMEOUT_MS = Number(process.env.EDGE_FUNCTION_TIMEOUT_MS || 15000);
const THIS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(THIS_DIRECTORY, "..");

if (!SUPABASE_URL || !/^https:\/\//i.test(SUPABASE_URL)) {
  throw new Error("SUPABASE_URL is missing or is not an HTTPS URL.");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");
}
if (!ROOT_DOMAIN || ROOT_DOMAIN.includes("/") || ROOT_DOMAIN.includes(" ")) {
  throw new Error("ROOT_DOMAIN must be a hostname, such as is-aroace.l.cd.");
}
if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES < 1024) {
  throw new Error("MAX_FILE_BYTES must be an integer of at least 1024 bytes.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

const app = express();
app.disable("x-powered-by");

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const functionUrl = `${SUPABASE_URL}/functions/v1/manage-website`;

function requestHostname(req) {
  return String(req.headers.host || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

// A tenant's site may be requested at either name.root-domain or
// www.name.root-domain. The final label before ROOT_DOMAIN identifies the site.
function tenantFromHost(hostname) {
  const suffix = `.${ROOT_DOMAIN}`;
  if (!hostname || !hostname.endsWith(suffix)) return null;

  const prefix = hostname.slice(0, -suffix.length);
  if (!prefix) return null;

  const labels = prefix.split(".");
  const label = labels[labels.length - 1];
  return labelPattern.test(label) ? label : null;
}

function normalizeSitePath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://router.invalid").pathname);
  } catch {
    return null;
  }

  if (pathname.includes("\0") || pathname.includes("\\") || pathname.length > 2048) {
    return null;
  }

  const trailingSlash = pathname.endsWith("/");
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((part) => part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
    return null;
  }

  let filePath = segments.join("/");
  if (!filePath || trailingSlash) {
    filePath = filePath ? `${filePath}/index.html` : "index.html";
  }

  return filePath;
}

function isLikelyMissingFile(responseStatus, payload) {
  const message = String(payload?.error || payload?.message || "").toLowerCase();
  return responseStatus === 404 || /file (was )?not found|file does not exist|no such file|missing file/.test(message);
}

async function getWebsiteFile(requestId, filePath) {
  const upstream = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      action: "get-file",
      requestId,
      path: filePath,
    }),
    signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT_MS),
  });

  const responseText = await upstream.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`manage-website returned non-JSON data (HTTP ${upstream.status}).`);
  }

  if (!upstream.ok || payload?.success !== true || !payload?.file) {
    if (isLikelyMissingFile(upstream.status, payload)) return null;
    const detail = String(payload?.error || payload?.message || `HTTP ${upstream.status}`);
    throw new Error(`manage-website get-file failed: ${detail}`);
  }

  const encoded = payload.file.content_base64;
  if (typeof encoded !== "string" || !encoded) {
    throw new Error("manage-website returned a file without content_base64.");
  }

  const content = Buffer.from(encoded, "base64");
  if (content.length > MAX_FILE_BYTES) {
    const error = new Error(`The requested file exceeds the ${MAX_FILE_BYTES}-byte router limit.`);
    error.statusCode = 413;
    throw error;
  }

  return {
    content,
    mimeType: typeof payload.file.mime_type === "string" ? payload.file.mime_type : "application/octet-stream",
    updatedAt: payload.file.updated_at || null,
  };
}

async function findPublishedSite(label) {
  const { data, error } = await supabase
    .from("subdomain_requests")
    .select("id,requested_label,status,website_published")
    .eq("requested_label", label)
    .eq("status", "approved")
    .eq("website_published", true)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not look up the published site: ${error.message}`);
  return data || null;
}

function sendWebsiteFile(req, res, file) {
  const safeMime = /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w=.+-]+)*$/.test(file.mimeType)
    ? file.mimeType
    : "application/octet-stream";
  const etag = `"${createHash("sha256").update(file.content).digest("base64url")}"`;

  res.set({
    "Content-Type": safeMime,
    "Content-Length": String(file.content.length),
    "Cache-Control": "no-cache, max-age=0, must-revalidate",
    "ETag": etag,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });

  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match) {
      res.set("Content-Range", `bytes */${file.content.length}`).status(416).end();
      return;
    }

    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.set("Content-Range", `bytes */${file.content.length}`).status(416).end();
        return;
      }
      start = Math.max(0, file.content.length - suffixLength);
      end = file.content.length - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : file.content.length - 1;
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.content.length) {
      res.set("Content-Range", `bytes */${file.content.length}`).status(416).end();
      return;
    }

    end = Math.min(end, file.content.length - 1);
    res.status(206);
    res.set({
      "Content-Range": `bytes ${start}-${end}/${file.content.length}`,
      "Content-Length": String(end - start + 1),
    });
    if (req.method === "HEAD") return res.end();
    return res.end(file.content.subarray(start, end + 1));
  }

  if (req.method === "HEAD") return res.end();
  return res.end(file.content);
}

app.get("/health", (req, res, next) => {
  // Allow the dashboard and a published user site to own a real /health page.
  const hostname = requestHostname(req);
  if (hostname === ROOT_DOMAIN || tenantFromHost(hostname)) return next();
  res.status(200).json({
    success: true,
    service: "is-aroace-website-router",
    rootDomain: ROOT_DOMAIN,
  });
});

app.use(async (req, res) => {
  const requestId = randomUUID();
  res.set("X-Request-Id", requestId);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.set("Allow", "GET, HEAD").status(405).type("text/plain").send("Method not allowed");
    return;
  }

  const hostname = requestHostname(req);

  // The apex/root domain continues to serve the existing dashboard files.
  // This lets the same Render service own both ROOT_DOMAIN and *.ROOT_DOMAIN,
  // which is required for Render wildcard-domain configuration.
  if (hostname === ROOT_DOMAIN) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD").status(405).type("text/plain").send("Method not allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.originalUrl, "http://router.invalid").pathname);
    } catch {
      res.status(400).type("text/plain").send("Invalid dashboard path.");
      return;
    }

    const dashboardFiles = new Map([
      ["/", "index.html"],
      ["/index.html", "index.html"],
      ["/app.js", "app.js"],
      ["/styles.css", "styles.css"],
      ["/config.js", "config.js"],
      ["/sw.js", "sw.js"],
      ["/favicon.ico", "favicon.ico"],
      ["/is-badge.png", "is-badge.png"],
      ["/404.html", "404.html"],
      ["/privacy", "privacy/index.html"],
      ["/privacy/", "privacy/index.html"],
      ["/privacy/index.html", "privacy/index.html"],
      ["/terms", "terms/index.html"],
      ["/terms/", "terms/index.html"],
      ["/terms/index.html", "terms/index.html"],
    ]);
    const relativeFile = dashboardFiles.get(pathname);
    if (!relativeFile) {
      res.status(404).type("text/plain").send("Dashboard page not found.");
      return;
    }

    res.set({
      "Cache-Control": pathname === "/config.js" ? "no-store" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.sendFile(path.join(REPOSITORY_ROOT, relativeFile), (error) => {
      if (error && !res.headersSent) {
        console.error(`[${requestId}] Dashboard file could not be served:`, error.message);
        res.status(error.statusCode || 404).type("text/plain").send("Dashboard file not found.");
      }
    });
    return;
  }

  if (hostname === `www.${ROOT_DOMAIN}`) {
    res.redirect(308, `https://${ROOT_DOMAIN}${req.originalUrl}`);
    return;
  }

  const tenantLabel = tenantFromHost(hostname);
  if (!tenantLabel) {
    res.status(404).type("text/plain").send("This hostname is not a published is-aroace website.");
    return;
  }

  const requestedPath = normalizeSitePath(req.originalUrl);
  if (!requestedPath) {
    res.status(400).type("text/plain").send("Invalid website path.");
    return;
  }

  try {
    const site = await findPublishedSite(tenantLabel);
    if (!site) {
      res.status(404).type("text/plain").send("This website has not been published.");
      return;
    }

    let file = await getWebsiteFile(site.id, requestedPath);

    // Support client-side routes such as /about when the site has an index.html.
    if (!file && requestedPath !== "index.html" && !requestedPath.includes(".")) {
      file = await getWebsiteFile(site.id, "index.html");
    }

    if (!file) {
      res.status(404).type("text/plain").send("Page not found.");
      return;
    }

    sendWebsiteFile(req, res, file);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    console.error(`[${requestId}] Website request failed for ${hostname}${req.path}:`, error?.message || error);
    if (!res.headersSent) {
      res.status(statusCode).type("text/plain").send(
        statusCode === 413 ? "This website file is too large for the router." : "The website could not be loaded. Please try again later."
      );
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`is-aroace website router listening on 0.0.0.0:${PORT}`);
  console.log(`Routing published sites under *.${ROOT_DOMAIN}`);
});
