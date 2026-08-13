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
const WORKSHOP_LOG_FILE = path.join(DATA_DIR, "workshop-log.json");
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || "").trim().toLowerCase();
const SITE_ACCESS_HASH = String(process.env.SITE_ACCESS_HASH || ADMIN_PASSWORD_HASH).trim().toLowerCase();
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_EVENTS = 500;

if (!/^[a-f0-9]{64}$/.test(ADMIN_PASSWORD_HASH)) {
  process.stderr.write("ERROR: Ustaw poprawne ADMIN_PASSWORD_HASH (sha256 hex) w zmiennych srodowiskowych.\n");
  process.exit(1);
}

if (!/^[a-f0-9]{64}$/.test(SITE_ACCESS_HASH)) {
  process.stderr.write("ERROR: Ustaw poprawne SITE_ACCESS_HASH (sha256 hex) w zmiennych srodowiskowych.\n");
  process.exit(1);
}

const sessions = new Map();
const updateSubscribers = new Map();

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

const defaultWorkshopLog = [
  {
    id: "workshop-2026-08-12",
    year: 2026,
    dateLabel: "AUGUST 12",
    title: "Four Platforms",
    description: "Intel Macs join the family, GPU cleanup gets cleaner defaults, and denoise consistency now survives every saved profile."
  },
  {
    id: "workshop-2026-08-10",
    year: 2026,
    dateLabel: "AUGUST 10",
    title: "The Library Opens",
    description: "Added a fresh starter pack, more adaptive presets, and smoother error messages when modules need attention."
  },
  {
    id: "workshop-2026-08-07",
    year: 2026,
    dateLabel: "AUGUST 7",
    title: "Stars for Everyone",
    description: "Star removal is now free for everyone and star replacement installs automatically on first launch."
  }
];

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

function normalizeLoginSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (!source) {
    return "unknown";
  }

  if (["form", "sequence", "launcher", "api"].includes(source)) {
    return source;
  }

  return "other";
}

function normalizeLabel(value, fallback) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 64);
}

function normalizeProgramOs(value) {
  const os = String(value || "").trim().toLowerCase();
  if (!os || os === "*" || os === "all" || os === "any") {
    return "any";
  }

  if (["mac", "macos", "osx", "darwin"].includes(os)) {
    return "macos";
  }

  if (["win", "windows", "win32"].includes(os)) {
    return "windows";
  }

  if (os === "linux") {
    return "linux";
  }

  return "other";
}

function inferVersionTargetOs(version) {
  if (!version || typeof version !== "object") {
    return ["any"];
  }

  if (version.linuxOnly) {
    return ["linux"];
  }

  const text = `${version.system || ""} ${version.format || ""} ${version.notes || ""}`.toLowerCase();
  const targets = new Set();

  if (/\bmac\b|macos|os x|darwin/.test(text)) {
    targets.add("macos");
  }
  if (/\bwin\b|windows|win32/.test(text)) {
    targets.add("windows");
  }
  if (/\blinux\b/.test(text)) {
    targets.add("linux");
  }

  if (targets.size === 0) {
    targets.add("any");
  }

  return [...targets];
}

function canProgramReceive(programOs, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return true;
  }

  if (programOs === "any") {
    return true;
  }

  if (targets.includes("any")) {
    return true;
  }

  return targets.includes(programOs);
}

function sendSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function addUpdateSubscriber(programOs, res) {
  const key = normalizeProgramOs(programOs);
  const set = updateSubscribers.get(key) || new Set();
  set.add(res);
  updateSubscribers.set(key, set);
}

function removeUpdateSubscriber(programOs, res) {
  const key = normalizeProgramOs(programOs);
  const set = updateSubscribers.get(key);
  if (!set) {
    return;
  }

  set.delete(res);
  if (set.size === 0) {
    updateSubscribers.delete(key);
  }
}

function broadcastVersionEvent(action, version) {
  const normalizedVersion = normalizeVersion(version);
  if (!normalizedVersion) {
    return;
  }

  const targets = inferVersionTargetOs(normalizedVersion);
  const payload = {
    action,
    targets,
    version: normalizedVersion,
    sentAt: new Date().toISOString()
  };

  for (const [programOs, subscribers] of updateSubscribers.entries()) {
    if (!canProgramReceive(programOs, targets)) {
      continue;
    }

    for (const client of subscribers) {
      try {
        sendSseEvent(client, "version-update", payload);
      } catch {
        removeUpdateSubscriber(programOs, client);
      }
    }
  }
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

function normalizeWorkshopEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const yearNumber = Number(entry.year);
  const dateLabel = String(entry.dateLabel || "").trim().toUpperCase();
  const title = String(entry.title || "").trim();
  const description = String(entry.description || "").trim();
  if (!Number.isInteger(yearNumber) || yearNumber < 1900 || yearNumber > 3000) {
    return null;
  }

  if (!dateLabel || dateLabel.length > 32) {
    return null;
  }

  if (!title || title.length > 120) {
    return null;
  }

  if (!description || description.length > 600) {
    return null;
  }

  return {
    id: String(entry.id || `workshop-${Date.now()}-${crypto.randomUUID()}`),
    year: yearNumber,
    dateLabel,
    title,
    description
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

function loadWorkshopLog() {
  const loaded = safeReadJson(WORKSHOP_LOG_FILE, defaultWorkshopLog);
  if (!Array.isArray(loaded)) {
    return [...defaultWorkshopLog];
  }

  const normalized = loaded.map(normalizeWorkshopEntry).filter(Boolean);
  if (normalized.length === 0) {
    return [...defaultWorkshopLog];
  }

  return normalized;
}

function saveWorkshopLog(entries) {
  saveJson(WORKSHOP_LOG_FILE, entries);
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

  if (!fs.existsSync(WORKSHOP_LOG_FILE)) {
    saveWorkshopLog(defaultWorkshopLog);
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

async function recordLoginEvent(req, status, source = "unknown", clientInfo = {}) {
  const ip = getClientIp(req);
  const ua = String(req.headers["user-agent"] || "");
  const geo = await lookupGeo(ip);
  const now = new Date();
  const headerOs = normalizeLabel(req.headers["x-client-os"], "");
  const headerBrowser = normalizeLabel(req.headers["x-client-browser"], "");
  const hintedOs = normalizeLabel(clientInfo.os, "");
  const hintedBrowser = normalizeLabel(clientInfo.browser, "");

  const event = {
    id: `evt-${Date.now()}-${crypto.randomUUID()}`,
    timestamp: now.toISOString(),
    time: now.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" }),
    os: headerOs || hintedOs || parseOs(ua),
    browser: headerBrowser || hintedBrowser || parseBrowser(ua),
    city: geo.city,
    country: geo.country,
    ip,
    status,
    source: normalizeLoginSource(source)
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

  if (req.method === "POST" && requestUrl.pathname === "/api/site-access/login") {
    readBody(req)
      .then((body) => {
        const password = String(body.password || "");
        const ok = hashValue(password) === SITE_ACCESS_HASH;
        sendJson(res, 200, { ok });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/versions") {
    const versions = loadVersions();
    sendJson(res, 200, { versions });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/workshop-log") {
    const entries = loadWorkshopLog();
    sendJson(res, 200, { entries });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/program/updates") {
    const programOs = normalizeProgramOs(requestUrl.searchParams.get("os"));
    const currentVersion = String(requestUrl.searchParams.get("currentVersion") || "").trim();
    const versions = loadVersions();

    const compatibleVersions = versions.filter((item) => canProgramReceive(programOs, inferVersionTargetOs(item)));
    const latest = compatibleVersions[0] || null;
    const hasUpdate = Boolean(latest && (!currentVersion || latest.version !== currentVersion));

    sendJson(res, 200, {
      os: programOs,
      hasUpdate,
      latestVersion: latest,
      count: compatibleVersions.length
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/program/updates/stream") {
    const programOs = normalizeProgramOs(requestUrl.searchParams.get("os"));

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.write(": connected\n\n");

    addUpdateSubscriber(programOs, res);
    sendSseEvent(res, "ready", {
      os: programOs,
      connectedAt: new Date().toISOString()
    });

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, 25_000);

    req.on("close", () => {
      clearInterval(keepAlive);
      removeUpdateSubscriber(programOs, res);
    });

    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/admin/login") {
    readBody(req)
      .then((body) => {
        const password = String(body.password || "");
        const source = normalizeLoginSource(body.source);
        const clientInfo = {
          os: normalizeLabel(body.clientOs, ""),
          browser: normalizeLabel(body.clientBrowser, "")
        };
        const isValid = hashValue(password) === ADMIN_PASSWORD_HASH;
        if (!isValid) {
          recordLoginEvent(req, "failed", source, clientInfo).catch(() => {
          });
          sendJson(res, 401, { error: "Bledne haslo admina." });
          return;
        }

        const token = crypto.randomUUID();
        sessions.set(token, Date.now() + TOKEN_TTL_MS);
        recordLoginEvent(req, "success", source, clientInfo).catch(() => {
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
        broadcastVersionEvent("created", candidate);
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
        broadcastVersionEvent("updated", candidate);
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
    const removed = versions.find((item) => item.id === id) || null;
    const nextVersions = versions.filter((item) => item.id !== id);
    if (nextVersions.length === versions.length) {
      sendJson(res, 404, { error: "Wersja nie istnieje." });
      return;
    }

    saveVersions(nextVersions);
    if (removed) {
      broadcastVersionEvent("deleted", removed);
    }
    sendJson(res, 200, { versions: nextVersions });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/workshop-log") {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    readBody(req)
      .then((body) => {
        const candidate = normalizeWorkshopEntry(body);
        if (!candidate) {
          sendJson(res, 400, { error: "Niepoprawne dane wpisu warsztatu." });
          return;
        }

        candidate.id = `workshop-${Date.now()}-${crypto.randomUUID()}`;
        const entries = [candidate, ...loadWorkshopLog()];
        saveWorkshopLog(entries);
        sendJson(res, 201, { entries });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "PUT" && requestUrl.pathname.startsWith("/api/workshop-log/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    const id = decodeURIComponent(requestUrl.pathname.replace("/api/workshop-log/", ""));
    readBody(req)
      .then((body) => {
        const candidate = normalizeWorkshopEntry({ ...body, id });
        if (!candidate) {
          sendJson(res, 400, { error: "Niepoprawne dane wpisu warsztatu." });
          return;
        }

        const entries = loadWorkshopLog();
        const index = entries.findIndex((item) => item.id === id);
        if (index === -1) {
          sendJson(res, 404, { error: "Wpis warsztatu nie istnieje." });
          return;
        }

        entries[index] = candidate;
        saveWorkshopLog(entries);
        sendJson(res, 200, { entries });
      })
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }

  if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/workshop-log/")) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "Brak autoryzacji." });
      return;
    }

    const id = decodeURIComponent(requestUrl.pathname.replace("/api/workshop-log/", ""));
    const entries = loadWorkshopLog();
    const nextEntries = entries.filter((item) => item.id !== id);
    if (nextEntries.length === entries.length) {
      sendJson(res, 404, { error: "Wpis warsztatu nie istnieje." });
      return;
    }

    saveWorkshopLog(nextEntries);
    sendJson(res, 200, { entries: nextEntries });
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
