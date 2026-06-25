import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PLUGGY_BASE_URL = process.env.PLUGGY_BASE_URL || "https://api.pluggy.ai";
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const SETTINGS_PATH = process.env.SETTINGS_PATH || path.join(__dirname, "settings.json");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_ALLOWED_EMAILS = String(process.env.GOOGLE_ALLOWED_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const REQUIRE_LOGIN = process.env.FINBOARD_REQUIRE_LOGIN === "true" || process.env.NODE_ENV === "production";
const SESSION_COOKIE_NAME = "finboard_session";

// ─── App token (obrigatório) ─────────────────────────────────────────────────
// Protege todas as rotas /api/*. Frontend recebe o token via cookie httpOnly
// ao carregar GET / na mesma origem; cookies same-origin são enviados
// automaticamente nas chamadas fetch — sem precisar mudar o frontend.
const APP_TOKEN = process.env.APP_TOKEN;
if (!APP_TOKEN || APP_TOKEN.length < 16) {
  console.error("FATAL: APP_TOKEN ausente ou muito curto no .env.");
  console.error('Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const COOKIE_NAME = "app_token";

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function jsonBase64url(data) {
  return base64url(JSON.stringify(data));
}

function signSession(payload) {
  const body = jsonBase64url(payload);
  const sig = crypto.createHmac("sha256", APP_TOKEN).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(req) {
  const raw = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!raw || !raw.includes(".")) return null;
  const [body, sig] = raw.split(".");
  const expected = crypto.createHmac("sha256", APP_TOKEN).update(body).digest("base64url");
  if (!timingSafeEq(sig, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (!session.email || !session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const maxAgeSeconds = 7 * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const session = {
    email: user.email,
    name: user.name || "",
    picture: user.picture || "",
    exp: Date.now() + maxAgeSeconds * 1000,
  };
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSession(session))}; Path=/; SameSite=Lax; HttpOnly${secure}; Max-Age=${maxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; SameSite=Lax; HttpOnly${secure}; Max-Age=0`);
}

async function verifyGoogleIdToken(idToken) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || "Token Google invalido");
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error("Token Google emitido para outro client_id");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
    throw new Error("Emissor Google invalido");
  }
  if (Number(payload.exp || 0) * 1000 < Date.now()) throw new Error("Token Google expirado");
  const email = String(payload.email || "").toLowerCase();
  if (!email || payload.email_verified !== "true") throw new Error("Email Google nao verificado");
  if (GOOGLE_ALLOWED_EMAILS.length && !GOOGLE_ALLOWED_EMAILS.includes(email)) {
    throw new Error("Email nao autorizado para este FinBoard");
  }
  return { email, name: payload.name || "", picture: payload.picture || "" };
}

function requireAuth(req, res, next) {
  if (GOOGLE_CLIENT_ID && readSession(req)) return next();
  const cookies = parseCookies(req);
  const fromCookie = cookies[COOKIE_NAME];
  const fromHeader = req.headers["x-app-token"];
  if (timingSafeEq(fromCookie, APP_TOKEN) || timingSafeEq(fromHeader, APP_TOKEN)) return next();
  return res.status(401).json({ ok: false, message: "Não autenticado" });
}

// ─── SQLite: KV store para dados do usuário (categorizações, manuais etc.) ────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const stmtGet = db.prepare("SELECT value, updated_at FROM kv WHERE key = ?");
const stmtPut = db.prepare(`
  INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const stmtDel = db.prepare("DELETE FROM kv WHERE key = ?");
const stmtAll = db.prepare("SELECT key, value, updated_at FROM kv");

// ─── CORS: bloqueia cross-origin. Mesmo localhost só same-origin é permitido. ─
// Antes: app.use(cors()) — qualquer site aberto no browser podia chamar /api/*.
const corsOptions = {
  origin: (origin, cb) => {
    // requests same-origin não têm header Origin: aceita
    if (!origin) return cb(null, true);
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    if (APP_BASE_URL) allowed.push(APP_BASE_URL);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error("Origin não permitida"), false);
  },
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: "5mb" }));

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true, service: 'finboard' });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    enabled: REQUIRE_LOGIN && !!GOOGLE_CLIENT_ID,
  });
});

app.get('/api/auth/me', (req, res) => {
  const session = readSession(req);
  res.json({ ok: true, authenticated: !!session, user: session ? { email: session.email, name: session.name, picture: session.picture } : null });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID nao configurado");
    const credential = req.body?.credential;
    if (!credential) return res.status(400).json({ ok: false, message: "Credential ausente" });
    const user = await verifyGoogleIdToken(credential);
    setSessionCookie(res, user);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(401).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

function requireLogin(req, res, next) {
  if (!REQUIRE_LOGIN) return next();
  if (req.path === "/api/webhooks/pluggy") return next();
  if (req.path === "/api/healthz") return next();
  if (req.path.startsWith("/api/auth/")) return next();
  if (req.path === "/login.html" || req.path === "/js/auth.js" || req.path === "/styles.css") return next();

  if (GOOGLE_CLIENT_ID) {
    const session = readSession(req);
    if (session) {
      req.user = session;
      return next();
    }
    if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, message: "Login Google requerido" });
    return res.redirect("/login.html");
  }

  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASSWORD) {
    return res.status(500).send("Configure GOOGLE_CLIENT_ID ou BASIC_AUTH_USER/BASIC_AUTH_PASSWORD no deploy.");
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.setHeader("WWW-Authenticate", 'Basic realm="FinBoard"');
    return res.status(401).send("Autenticacao requerida");
  }
  let user = "";
  let password = "";
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    user = decoded.slice(0, idx);
    password = decoded.slice(idx + 1);
  } catch {
    res.setHeader("WWW-Authenticate", 'Basic realm="FinBoard"');
    return res.status(401).send("Autenticacao requerida");
  }
  if (timingSafeEq(user, BASIC_AUTH_USER) && timingSafeEq(password, BASIC_AUTH_PASSWORD)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="FinBoard"');
  return res.status(401).send("Autenticacao requerida");
}

app.use(requireLogin);

// ─── Servir o frontend ───────────────────────────────────────────────────────
// Servimos a pasta public/ inteira (index.html, styles.css, js/*.js). Como ela
// só contém os arquivos do front, expor "tudo lá dentro" é seguro. .env,
// settings.json, data.db e server.js ficam FORA do public/ e não são acessíveis.
// O cookie de auth é setado quando o browser carrega "/" pela primeira vez.
const PUBLIC_DIR = path.join(__dirname, "public");
app.use((req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${encodeURIComponent(APP_TOKEN)}; Path=/; SameSite=Strict; HttpOnly; Max-Age=2592000`
    );
  }
  next();
});
app.use(express.static(PUBLIC_DIR, { index: "index.html", extensions: ["html"] }));

let authCache = { apiKey: null, expiresAt: 0, cacheKey: null };

function readSettings() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch { /* arquivo pode não existir ainda */ }
  // .env tem precedência sobre settings.json para credenciais
  return {
    clientId: process.env.PLUGGY_CLIENT_ID || parsed.clientId || "",
    clientSecret: process.env.PLUGGY_CLIENT_SECRET || parsed.clientSecret || "",
    itemIds: Array.isArray(parsed.itemIds)
      ? parsed.itemIds.filter(Boolean)
      : String(parsed.itemIds || process.env.PLUGGY_ITEM_IDS || process.env.PLUGGY_ITEM_ID || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    clientUserId: parsed.clientUserId || process.env.PLUGGY_CLIENT_USER_ID || "",
    webhookUrl: parsed.webhookUrl || process.env.PLUGGY_WEBHOOK_URL || "",
  };
}

function writeSettingsSafe(data) {
  // Nunca grava clientId/clientSecret em settings.json — eles ficam só no .env.
  const current = readSettings();
  const safe = {
    itemIds: Array.isArray(data.itemIds) ? data.itemIds : current.itemIds,
    clientUserId: data.clientUserId ?? current.clientUserId ?? "",
    webhookUrl: data.webhookUrl ?? current.webhookUrl ?? "",
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(safe, null, 2) + "\n", "utf-8");
}

const ENV_PATH = path.join(__dirname, ".env");
function updateEnvFile(updates) {
  // Lê o .env atual, substitui as linhas das chaves passadas e reescreve.
  // Também atualiza process.env para que getApiKey() veja o valor novo sem restart.
  let content = "";
  try { content = fs.readFileSync(ENV_PATH, "utf-8"); } catch {}
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (re.test(content)) content = content.replace(re, line);
    else content = content + (content.endsWith("\n") ? "" : "\n") + line + "\n";
    process.env[key] = value;
  }
  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

async function getApiKey() {
  const settings = readSettings();
  const clientId = settings.clientId;
  const clientSecret = settings.clientSecret;
  if (!clientId || !clientSecret) throw new Error("Client ID / Client Secret não configurados (defina no .env)");

  const cacheKey = `${clientId}:${clientSecret}`;
  if (authCache.apiKey && authCache.expiresAt > Date.now() + 60_000 && authCache.cacheKey === cacheKey) return authCache.apiKey;

  const res = await fetch(`${PLUGGY_BASE_URL}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "Falha ao autenticar na Pluggy");
  const apiKey = data.apiKey || data.key || data.token;
  if (!apiKey) throw new Error("Resposta de autenticação sem apiKey");

  authCache = { apiKey, expiresAt: Date.now() + 110 * 60 * 1000, cacheKey };
  return apiKey;
}

async function pluggyFetch(pathname, options = {}) {
  const apiKey = await getApiKey();
  const res = await fetch(`${PLUGGY_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.message || data.codeDescription || data.error || `Erro HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function normalizeListPayload(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

async function fetchAccountsWithTransactions(itemId) {
  const accountsData = await pluggyFetch(`/accounts?itemId=${encodeURIComponent(itemId)}`);
  const accounts = normalizeListPayload(accountsData);
  return Promise.all(accounts.map(async (account) => {
    try {
      const txData = await pluggyFetch(`/transactions?accountId=${encodeURIComponent(account.id)}`);
      return { ...account, transactions: normalizeListPayload(txData), itemId };
    } catch (e) {
      return { ...account, transactions: [], transactionsError: e.message, itemId };
    }
  }));
}

async function fetchInvestments(itemId) {
  try {
    const data = await pluggyFetch(`/investments?itemId=${encodeURIComponent(itemId)}`);
    return normalizeListPayload(data).map((x) => ({ ...x, itemId }));
  } catch { return []; }
}

async function fetchIdentities(itemId) {
  try {
    const data = await pluggyFetch(`/identities?itemId=${encodeURIComponent(itemId)}`);
    return normalizeListPayload(data).map((x) => ({ ...x, itemId }));
  } catch { return []; }
}

async function fetchLoans(itemId) {
  try {
    const data = await pluggyFetch(`/loans?itemId=${encodeURIComponent(itemId)}`);
    return normalizeListPayload(data).map((x) => ({ ...x, itemId }));
  } catch { return []; }
}

async function fetchItems(itemIds) {
  return Promise.all(itemIds.map(async (itemId) => {
    try {
      return await pluggyFetch(`/items/${encodeURIComponent(itemId)}`);
    } catch (e) {
      return { id: itemId, unavailable: true, error: e.message };
    }
  }));
}

async function createConnectToken({ clientUserId, itemId } = {}) {
  const s = readSettings();
  const body = {
    clientUserId: clientUserId || s.clientUserId || undefined,
    itemId: itemId || undefined,
    webhookUrl: s.webhookUrl || undefined,
    avoidDuplicates: true,
  };
  const data = await pluggyFetch('/connect_token', { method: 'POST', body: JSON.stringify(body) });
  const accessToken = data.accessToken || data.connectToken || data.token;
  return { accessToken, ...data };
}

function extractWebhookItemId(event) {
  return event?.itemId || event?.item?.id || event?.data?.itemId || event?.data?.item?.id || null;
}

function addItemIdToSettings(itemId) {
  if (!itemId) return false;
  const s = readSettings();
  if (s.itemIds.includes(itemId)) return false;
  writeSettingsSafe({ itemIds: [...s.itemIds, itemId] });
  return true;
}

function rememberWebhookEvent(event) {
  const key = "pluggy_webhook_events_v1";
  let events = [];
  const row = stmtGet.get(key);
  if (row) {
    try { events = JSON.parse(row.value); } catch { events = []; }
  }
  events.unshift({
    receivedAt: new Date().toISOString(),
    event: event?.event || event?.type || "unknown",
    eventId: event?.eventId || event?.id || null,
    itemId: extractWebhookItemId(event),
  });
  stmtPut.run(key, JSON.stringify(events.slice(0, 50)), Date.now());
}

app.post('/api/webhooks/pluggy', (req, res) => {
  try {
    const event = req.body || {};
    rememberWebhookEvent(event);
    const type = event.event || event.type;
    if (type === 'item/created' || type === 'item/updated') {
      addItemIdToSettings(extractWebhookItemId(event));
    }
    if (type === 'item/error') {
      console.warn('Pluggy item error webhook:', {
        eventId: event.eventId || event.id,
        itemId: extractWebhookItemId(event),
        error: event.error || event.data?.error,
      });
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('Pluggy webhook failed:', error);
    return res.status(500).json({ received: false, message: error.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Todas as rotas /api/* exigem o cookie/header de auth
// ═════════════════════════════════════════════════════════════════════════
app.use("/api", requireAuth);

app.get('/api/admin/settings', (_req, res) => {
  const s = readSettings();
  res.json({ ok: true, settings: { clientId: s.clientId, clientSecretMasked: mask(s.clientSecret), itemIds: s.itemIds, clientUserId: s.clientUserId, webhookUrl: s.webhookUrl, credentialsSource: process.env.PLUGGY_CLIENT_ID ? 'env' : 'settings.json' } });
});

app.post('/api/admin/settings', (req, res) => {
  const body = req.body || {};

  // Credenciais Pluggy: gravadas no .env (não em settings.json). Campo em
  // branco = manter; preenchido = sobrescrever. Atualização vale em runtime,
  // sem precisar reiniciar o server.
  const envUpdates = {};
  if (typeof body.clientId === 'string' && body.clientId.trim()) {
    envUpdates.PLUGGY_CLIENT_ID = body.clientId.trim();
  }
  if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
    envUpdates.PLUGGY_CLIENT_SECRET = body.clientSecret.trim();
  }
  if (Object.keys(envUpdates).length) {
    try {
      updateEnvFile(envUpdates);
    } catch (e) {
      return res.status(500).json({ ok: false, message: 'Falha ao atualizar .env: ' + e.message });
    }
  }

  const itemIds = Array.isArray(body.itemIds)
    ? body.itemIds.map(x => String(x).trim()).filter(Boolean)
    : String(body.itemIds || '').split(/\n|,/).map(x => x.trim()).filter(Boolean);
  const settings = {
    itemIds,
    clientUserId: String(body.clientUserId || '').trim(),
    webhookUrl: String(body.webhookUrl || '').trim(),
  };
  writeSettingsSafe(settings);
  authCache = { apiKey: null, expiresAt: 0, cacheKey: null };
  const s = readSettings();
  res.json({ ok: true, settings: { clientId: s.clientId, clientSecretMasked: mask(s.clientSecret), itemIds: s.itemIds, clientUserId: s.clientUserId, webhookUrl: s.webhookUrl, credentialsUpdated: Object.keys(envUpdates) } });
});

app.get('/api/health', async (_req, res) => {
  try {
    const s = readSettings();
    const apiKey = await getApiKey();
    res.json({ ok: true, apiKeyLoaded: !!apiKey, baseUrl: PLUGGY_BASE_URL, itemIds: s.itemIds, configured: !!s.clientId && !!s.clientSecret });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/api/connect-token', async (req, res) => {
  try {
    const data = await createConnectToken({
      clientUserId: req.query.clientUserId,
      itemId: req.query.itemId,
    });
    res.json({ ok: true, ...data });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message, details: error.payload || null });
  }
});

app.post('/api/connect-token', async (req, res) => {
  try {
    const data = await createConnectToken(req.body || {});
    res.json({ accessToken: data.accessToken, ok: true, ...data });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message, details: error.payload || null });
  }
});

app.get('/api/full-sync', async (_req, res) => {
  try {
    const s = readSettings();
    if (!s.itemIds.length) throw new Error('Nenhum itemId configurado');
    const [items, accountsGrouped, investmentsGrouped, identitiesGrouped, loansGrouped] = await Promise.all([
      fetchItems(s.itemIds),
      Promise.all(s.itemIds.map(async itemId => ({ itemId, accounts: await fetchAccountsWithTransactions(itemId) }))),
      Promise.all(s.itemIds.map(async itemId => ({ itemId, investments: await fetchInvestments(itemId) }))),
      Promise.all(s.itemIds.map(async itemId => ({ itemId, identities: await fetchIdentities(itemId) }))),
      Promise.all(s.itemIds.map(async itemId => ({ itemId, loans: await fetchLoans(itemId) }))),
    ]);
    const accounts = accountsGrouped.flatMap(x => x.accounts);
    const investments = investmentsGrouped.flatMap(x => x.investments);
    const identities = identitiesGrouped.flatMap(x => x.identities);
    const loans = loansGrouped.flatMap(x => x.loans);
    res.json({ ok: true, itemIds: s.itemIds, items, accounts, investments, identities, loans, grouped: { accounts: accountsGrouped, investments: investmentsGrouped, identities: identitiesGrouped, loans: loansGrouped } });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message, details: error.payload || null });
  }
});

app.get('/api/pluggy/categories', async (_req, res) => {
  try {
    const data = await pluggyFetch('/categories');
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, message: error.message, details: error.payload || null });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// KV Store endpoints — substitui localStorage do frontend
// ═════════════════════════════════════════════════════════════════════════

const ALLOWED_KEYS = new Set([
  "pluggy_rules_allinone",
  "pluggy_manual_allinone",
  "pluggy_custom_names_v1",
  "pluggy_cat_groups_v1",
  "pluggy_excl_cats_v1",
  "pluggy_inv_cats_v1",
  "pluggy_manual_invs_v1",
  "pluggy_manual_cards_v1",
  "pluggy_manual_card_txs_v1",
  "pluggy_acc_names_v1",
  "pluggy_cat_custom_names_v1",
]);

function isAllowedKey(k) { return ALLOWED_KEYS.has(k); }

app.get('/api/kv', (_req, res) => {
  try {
    const rows = stmtAll.all();
    const out = {};
    for (const r of rows) {
      try { out[r.key] = JSON.parse(r.value); }
      catch { out[r.key] = r.value; }
    }
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get('/api/kv/:key', (req, res) => {
  try {
    if (!isAllowedKey(req.params.key)) {
      return res.status(400).json({ ok: false, message: 'Chave não permitida' });
    }
    const row = stmtGet.get(req.params.key);
    if (!row) return res.json({ ok: true, key: req.params.key, value: null, found: false });
    let value;
    try { value = JSON.parse(row.value); } catch { value = row.value; }
    res.json({ ok: true, key: req.params.key, value, updated_at: row.updated_at, found: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.put('/api/kv/:key', (req, res) => {
  try {
    if (!isAllowedKey(req.params.key)) {
      return res.status(400).json({ ok: false, message: 'Chave não permitida' });
    }
    const body = req.body || {};
    if (!('value' in body)) {
      return res.status(400).json({ ok: false, message: 'Body precisa ter { value: ... }' });
    }
    const valueStr = typeof body.value === 'string' ? body.value : JSON.stringify(body.value);
    stmtPut.run(req.params.key, valueStr, Date.now());
    res.json({ ok: true, key: req.params.key, updated_at: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.delete('/api/kv/:key', (req, res) => {
  try {
    if (!isAllowedKey(req.params.key)) {
      return res.status(400).json({ ok: false, message: 'Chave não permitida' });
    }
    stmtDel.run(req.params.key);
    res.json({ ok: true, key: req.params.key });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post('/api/kv/bulk', (req, res) => {
  try {
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, message: 'Body precisa ter { data: { key: value, ... } }' });
    }
    const now = Date.now();
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) {
        if (!isAllowedKey(k)) continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        stmtPut.run(k, s, now);
      }
    });
    tx(Object.entries(data));
    res.json({ ok: true, written: Object.keys(data).filter(isAllowedKey).length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 404 padrão para qualquer outra rota
app.use((_req, res) => res.status(404).json({ ok: false, message: 'Not found' }));

// Error handler global — pega throws síncronos das rotas
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, message: err.message || 'Internal error' });
});

app.listen(PORT, HOST, () => console.log(`Pluggy all-in-one em http://${HOST}:${PORT}`));
