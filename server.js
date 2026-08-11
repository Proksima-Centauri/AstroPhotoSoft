const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "protected");
const VERSIONS_FILE = path.join(DATA_DIR, "versions.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const LOGIN_EVENTS_FILE = path.join(DATA_DIR, "login-events.json");
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "8b32f2fa6401eb1ec35d95d078201c9a0169de4297a7466daf3984cbda358a9b";
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_EVENTS = 500;

const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".sh": "text/plain; charset=utf-8"
};

const defaultVersions = [
  {
    id: "linux-stable-1",
    version: "1.0.0",
    system: "Linux (x86_64)",
    format: "skrypt startowy (przykladowy pakiet)",
    href: "../downloads/astro-ai-plus-linux.sh",
    linuxOnly: true,
    notes: "Wydanie startowe"
  }
];

const defaultSettings = {
  shortcut: "delta1/6"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function safeReadJson(filePath, fallbackValue) {
  try {
    const data = fs.readFileSync(filePath, "utf8");
    return JSON.parse(data);
  } catch {
    return fallbackValue;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeShortcut(value) {
  const shortcut = String(value || "").trim().toLowerCase();
  if (!shortcut || shortcut.length > 64 || /\s/.test(shortcut)) {
    return null;
  }
  return shortcut;
}

function normalizeVersion(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const version = String(entry.version || "").trim();
  const system = String(entry.system || "").trim();
  const format = String(entry.format || "").trim();
  const href = String(entry.href || "").trim();
  const notes = String(entry.notes || "").trim();
  if (!version || !system || !format || !href) {
    return null;
  }

  return {
    id: String(entry.id || `release-${Date.now()}-${crypto.randomUUID()}`),
    version,
    system,
    format,
    href,
    linuxOnly: Boolean(entry.linuxOnly),
    notes
  };
}

function loadVersions() {
  const loaded = safeReadJson(VERSIONS_FILE, defaultVersions);
  if (!Array.isArray(loaded)) {
    return [...defaultVersions];
  }

  const normalized = loaded.map(normalizeVersion).filter(Boolean);
  if (normalized.length === 0) {
    return [...defaultVersions];
  }

  return normalized;
}

function saveVersions(versions) {
  saveJson(VERSIONS_FILE, versions);
}

function loadSettings() {
  const loaded = safeReadJson(SETTINGS_FILE, defaultSettings);
  const shortcut = normalizeShortcut(loaded && loaded.shortcut);
  return {
    shortcut: shortcut || defaultSettings.shortcut
  };
}

function saveSettings(settings) {
  saveJson(SETTINGS_FILE, settings);
}

function loadLoginEvents() {
  const loaded = safeReadJson(LOGIN_EVENTS_FILE, []);
  if (!Array.isArray(loaded)) {
    return [];
  }
  return loaded.filter((item) => item && typeof item === "object").slice(0, MAX_LOGIN_EVENTS);
}

function saveLoginEvents(events) {
  saveJson(LOGIN_EVENTS_FILE, events.slice(0, MAX_LOGIN_EVENTS));
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(VERSIONS_FILE)) {
    saveVersions(defaultVersions);
  }

  if (!fs.existsSync(SETTINGS_FILE)) {
    saveSettings(defaultSettings);
  }

  if (!fs.existsSync(LOGIN_EVENTS_FILE)) {
    saveLoginEvents([]);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Za duzy payload."));
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Niepoprawny JSON."));
      }
    });

    req.on("error", reject);
  });
}

function parseToken(req) {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }
  return token;
}

function isAuthorized(req) {
  const token = parseToken(req);
  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);
  if (!expiresAt || Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseBrowser(userAgent) {
  const ua = String(userAgent || "");
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  return "Unknown";
}

function parseOs(userAgent) {
  const ua = String(userAgent || "");
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

function normalizeIp(ip) {
  const value = String(ip || "").trim();
  if (!value) {
    return "unknown";
  }

  if (value.startsWith("::ffff:")) {
    return value.replace("::ffff:", "");
  }

  return value;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "";
  return normalizeIp(ip);
}

function isPrivateIp(ip) {
  if (ip === "unknown" || ip === "::1" || ip === "127.0.0.1") {
    return true;
  }

  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) {
    return true;
  }

  const match172 = ip.match(/^172\.(\d+)\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
}

async function lookupGeo(ip) {
  if (isPrivateIp(ip)) {
    return { city: "Local", country: "Local" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(`https://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { city: "Unknown", country: "Unknown" };
    }

    const payload = await response.json();
    if (!payload || payload.status !== "success") {
      return { city: "Unknown", country: "Unknown" };
    }

    return {
      city: String(payload.city || "Unknown"),
      country: String(payload.country || "Unknown")
    };
  } catch {
    clearTimeout(timeout);
    return { city: "Unknown", country: "Unknown" };
  }
}

async function recordLoginEvent(req, status) {
  const ip = getClientIp(req);
  const ua = String(req.headers["user-agent"] || "");
  const geo = await lookupGeo(ip);
  const now = new Date();

  const event = {
    id: `evt-${Date.now()}-${crypto.randomUUID()}`,
    timestamp: now.toISOString(),
    time: now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }),
    os: parseOs(ua),
    browser: parseBrowser(ua),
    city: geo.city,
    country: geo.country,
    ip,
    status
  };

  const events = [event, ...loadLoginEvents()].slice(0, MAX_LOGIN_EVENTS);
  saveLoginEvents(events);
}

function routeApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/settings") {
    const settings = loadSettings();
    sendJson(res, 200, { shortcut: settings.shortcut });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/versions") {
    const versions = loadVersions();
    sendJson(res, 200, { versions });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/login") {
    readBody(req)
      .then((body) => {
        const password = String(body.password || "");
        const isValid = hashValue(password) === ADMIN_PASSWORD_HASH;
        if (!isValid) {
          recordLoginEvent(req, "failed").catch(() => {
          });
          sendJson(res, 401, { error: "Bledne haslo admina." });
          return;
        }

        const token = crypto.randomUUID();
        sessions.set(token, Date.now() + TOKEN_TTL_MS);
        recordLoginEvent(req, "success").catch(() => {
        });
        sendJson(res, 200, { token });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/logout") {
    const token = parseToken(req);
    if (token) {
      sessions.delete(token);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/admin/login-events") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    const limit = Math.max(1, Math.min(MAX_LOGIN_EVENTS, Number(requestUrl.searchParams.get("limit") || 200)));
    const events = loadLoginEvents().slice(0, limit);
    sendJson(res, 200, { events });
    return;
  }

  if (req.method === "PUT" && requestUrl.pathname === "/api/settings/shortcut") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    readBody(req)
      .then((body) => {
        const shortcut = normalizeShortcut(body.shortcut);
        if (!shortcut) {
          sendJson(res, 400, { error: "Niepoprawny skrot." });
          return;
        }

        saveSettings({ shortcut });
        sendJson(res, 200, { shortcut });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/versions") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    readBody(req)
      .then((body) => {
        const candidate = normalizeVersion(body);
        if (!candidate) {
          sendJson(res, 400, { error: "Niepoprawne dane wersji." });
          return;
        }

        candidate.id = `release-${Date.now()}-${crypto.randomUUID()}`;
        const versions = [candidate, ...loadVersions()];
        saveVersions(versions);
        sendJson(res, 201, { versions });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "PUT" && requestUrl.pathname.startsWith("/api/versions/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    const id = decodeURIComponent(requestUrl.pathname.replace("/api/versions/", ""));
    readBody(req)
      .then((body) => {
        const candidate = normalizeVersion({ ...body, id });
        if (!candidate) {
          sendJson(res, 400, { error: "Niepoprawne dane wersji." });
          return;
        }

        const versions = loadVersions();
        const index = versions.findIndex((item) => item.id === id);
        if (index === -1) {
          sendJson(res, 404, { error: "Wersja nie istnieje." });
          return;
        }

        versions[index] = candidate;
        saveVersions(versions);
        sendJson(res, 200, { versions });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/versions/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    const id = decodeURIComponent(requestUrl.pathname.replace("/api/versions/", ""));
    const versions = loadVersions();
    const nextVersions = versions.filter((item) => item.id !== id);
    if (nextVersions.length === versions.length) {
      sendJson(res, 404, { error: "Wersja nie istnieje." });
      return;
    }

    saveVersions(nextVersions);
    sendJson(res, 200, { versions: nextVersions });
    return;
  }

  sendJson(res, 404, { error: "Nie znaleziono endpointu API." });
}

function serveStatic(req, res, requestUrl) {
  const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const rawPath = path.join(ROOT_DIR, requestPath);
  const normalizedPath = path.normalize(rawPath);
  if (!normalizedPath.startsWith(ROOT_DIR)) {
    sendText(res, 403, "Access denied");
    return;
  }

  fs.stat(normalizedPath, (statError, stats) => {
    if (statError) {
      sendText(res, 404, "Not found");
      return;
    }

    let filePath = normalizedPath;
    if (stats.isDirectory()) {
      filePath = path.join(normalizedPath, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readError, file) => {
      if (readError) {
        sendText(res, 404, "Not found");
        return;
      }

      res.writeHead(200, { "Content-Type": contentType });
      res.end(file);
    });
  });
}

ensureDataFiles();

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    routeApi(req, res, requestUrl);
    return;
  }

  serveStatic(req, res, requestUrl);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Server running at http://${HOST}:${PORT}\n`);
});
