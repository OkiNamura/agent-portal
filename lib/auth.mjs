/**
 * Пользователи, пароли и сессии локального портала.
 *
 * Хранилище — config/users.json ({ users: [...], sessions: [...] }).
 * Путь можно переопределить через USERS_FILE (нужно проверкам и тестам).
 *
 * Пароль: scrypt с солью, формат строки `scrypt$N$r$p$saltHex$hashHex`.
 * Сессия: токен 32 байта hex, живёт 12 часов; копия в памяти и в файле.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const SESSION_COOKIE = "portal_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000); // 43200 секунд
export const ROLES = Object.freeze(["viewer", "editor", "admin"]);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* Параметры scrypt: ~16 МБ памяти, ~40 мс на проверку — нормально для локального входа. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;

const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Текущее содержимое users.json; null — файла ещё нет. */
let cache = null;
/** Быстрый доступ к сессиям: token → { token, userId, createdAt, expiresAt }. */
const sessions = new Map();

/* ------------------------------- хранилище ------------------------------- */

export function usersFile() {
  const override = process.env.USERS_FILE || process.env.AUTH_FILE;
  return override ? path.resolve(override) : path.join(ROOT, "config", "users.json");
}

function normalizeData(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  return {
    users: Array.isArray(data.users) ? data.users.filter((u) => u && u.id && u.login) : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
  };
}

function readFileData() {
  const file = usersFile();
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return { users: [], sessions: [] };
  return normalizeData(JSON.parse(raw));
}

function writeFileData(data) {
  const file = usersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { users: data.users ?? [], sessions: data.sessions ?? [] };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Записать текущее состояние (сессии берём из памяти). */
function persist() {
  if (!cache) return;
  cache.sessions = [...sessions.values()];
  writeFileData(cache);
}

function hydrateSessions(fileSessions) {
  sessions.clear();
  const now = Date.now();
  for (const s of fileSessions ?? []) {
    if (!s || typeof s.token !== "string" || !s.userId) continue;
    if (!Number.isFinite(Number(s.expiresAt)) || Number(s.expiresAt) <= now) continue;
    sessions.set(s.token, s);
  }
  if (cache) cache.sessions = [...sessions.values()];
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of sessions) {
    if (!s || !Number.isFinite(Number(s.expiresAt)) || Number(s.expiresAt) <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  return changed;
}

/* --------------------------------- пароли --------------------------------- */

/** scrypt-хеш в формате `scrypt$N$r$p$salt$hash` (hex). */
export function hashPassword(password) {
  const pass = String(password ?? "");
  if (!pass) throw new Error("Пустой пароль");
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(pass, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("hex"), hash.toString("hex")].join("$");
}

function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password ?? ""), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ------------------------------- первый вход ------------------------------- */

function randomPassword(length = 12) {
  let out = "";
  while (out.length < length) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

function publicUser(user) {
  return { id: user.id, login: user.login, role: user.role, createdAt: user.createdAt ?? null };
}

function addAdminLocked() {
  const password = randomPassword(12);
  const user = {
    id: `u-${crypto.randomBytes(4).toString("hex")}`,
    login: "admin",
    passHash: hashPassword(password),
    role: "admin",
    createdAt: new Date().toISOString(),
  };
  cache.users.push(user);
  return { user, password };
}

function announceFirstAdmin(user, password) {
  console.log("");
  console.log("  ┌─ первый запуск: создан администратор ─────────────");
  console.log(`  │  логин:  ${user.login}`);
  console.log(`  │  пароль: ${password}`);
  console.log("  │  Пароль показывается один раз — сохрани его.");
  console.log(`  │  Файл:   ${usersFile()}`);
  console.log("  └───────────────────────────────────────────────────");
  console.log("");
}

/* ------------------------------- публичный API ------------------------------- */

/**
 * Читает пользователей (и при первом запуске создаёт админа).
 * Возвращает { users, sessions } — sessions из файла; рабочая копия живёт в Map.
 */
export function loadUsers() {
  if (cache) return cache;

  let data = null;
  let recovered = false;
  try {
    data = readFileData();
  } catch (err) {
    // Битый JSON не должен запирать портал: откладываем файл и начинаем с админа.
    const file = usersFile();
    const broken = `${file}.broken-${Date.now()}`;
    try {
      fs.renameSync(file, broken);
      console.warn(`[auth] ${file} не прочитался (${err.message}) — переименован в ${broken}`);
    } catch {
      console.warn(`[auth] ${file} не прочитался (${err.message})`);
    }
    recovered = true;
    data = { users: [], sessions: [] };
  }

  if (!data) data = { users: [], sessions: [] };
  cache = { users: data.users, sessions: [] };
  const before = data.sessions.length;
  hydrateSessions(data.sessions);
  const pruned = sessions.size !== before;

  let created = null;
  if (!cache.users.length) {
    created = addAdminLocked();
    persist();
    announceFirstAdmin(created.user, created.password);
  } else if (pruned && !recovered) {
    persist();
  }

  return cache;
}

/** Полная замена содержимого users.json (например, из скрипта). */
export function saveUsers(data) {
  if (!data || !Array.isArray(data.users)) throw new Error("saveUsers: нужен объект { users: [...] }");
  cache = normalizeData(data);
  if (Array.isArray(data.sessions)) hydrateSessions(data.sessions);
  else cache.sessions = [...sessions.values()];
  writeFileData(cache);
  return cache;
}

/** Проверка логина/пароля. Возвращает { id, login, role } или null. */
export function verify(login, password) {
  const data = loadUsers();
  const name = String(login ?? "").trim().toLowerCase();
  const user = data.users.find((u) => String(u.login ?? "").trim().toLowerCase() === name);
  if (!user) {
    // выравниваем время ответа, чтобы по нему нельзя было искать логины
    hashPassword("dummy-password-for-timing");
    return null;
  }
  if (!verifyPassword(String(password ?? ""), user.passHash)) return null;
  return { id: user.id, login: user.login, role: user.role };
}

/* --------------------------------- сессии --------------------------------- */

function dropExpired() {
  if (pruneSessions()) {
    try {
      persist();
    } catch (err) {
      console.error("[auth] не удалось сохранить сессии:", err.message);
    }
  }
}

/** Создаёт сессию и возвращает токен (32 байта hex). */
export function createSession(userId) {
  const data = loadUsers();
  const user = data.users.find((u) => u.id === userId);
  if (!user) throw new Error("Пользователь не найден");
  dropExpired();
  const now = Date.now();
  const token = crypto.randomBytes(32).toString("hex");
  const session = {
    token,
    userId: user.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  persist();
  return token;
}

/** Возвращает { token, userId, createdAt, expiresAt, login, role } или null. */
export function getSession(token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const data = loadUsers();
  const session = sessions.get(token);
  if (!session) return null;
  if (!Number.isFinite(Number(session.expiresAt)) || Number(session.expiresAt) <= Date.now()) {
    dropSession(token);
    return null;
  }
  const user = data.users.find((u) => u.id === session.userId);
  if (!user) {
    dropSession(token);
    return null;
  }
  return { ...session, login: user.login, role: user.role };
}

export function dropSession(token) {
  if (typeof token !== "string" || !sessions.has(token)) return false;
  loadUsers();
  sessions.delete(token);
  try {
    persist();
  } catch (err) {
    console.error("[auth] не удалось сохранить сессии:", err.message);
  }
  return true;
}

function cookieValue(header, name) {
  if (typeof header !== "string" || !header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/** Пользователь по cookie `portal_session` из запроса (или null). */
export function requireUser(req) {
  const token = cookieValue(req?.headers?.cookie, SESSION_COOKIE);
  if (!token) return null;
  return getSession(token);
}

/* ------------------------------ роли: одна проверка ------------------------------ */

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const USERS_PATH = /^\/api\/users(?:\/|$)/;
const KEYS_PATH = /^\/api\/keys(?:\/|$)/;
const PROJECT_ONE = /^\/api\/projects\/[^/]+\/?$/;

function forbid(res, error) {
  const body = JSON.stringify({ error });
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
  return true;
}

/**
 * Единственная проверка прав. true — запрос отклонён (403 уже отправлен).
 *
 * viewer — только чтение;
 * editor — всё, кроме изменения ключей/пользователей и удаления проектов;
 * admin  — всё.
 */
export function deny(res, role, method, pathname) {
  const m = String(method ?? "GET").toUpperCase();
  const p = String(pathname ?? "");

  if (role === "admin") return false;
  if (role !== "viewer" && role !== "editor") return forbid(res, "неизвестная роль — нужен администратор");

  if (USERS_PATH.test(p)) return forbid(res, "пользователями управляет администратор");
  if (READ_METHODS.has(m)) return false;
  if (role === "viewer") return forbid(res, "роль viewer: только чтение");
  if (KEYS_PATH.test(p)) return forbid(res, "ключи меняет администратор");
  if (m === "DELETE" && PROJECT_ONE.test(p)) return forbid(res, "проекты удаляет администратор");
  return false;
}

/* ----------------------------- управление людьми ----------------------------- */

export function listUsers() {
  return loadUsers().users.map(publicUser);
}

export function createUser({ login, password, role = "viewer" } = {}) {
  const data = loadUsers();
  const name = String(login ?? "").trim();
  if (!LOGIN_RE.test(name)) throw new Error("Логин: 3–32 символа, латиница/цифры/._-");
  if (data.users.some((u) => String(u.login).toLowerCase() === name.toLowerCase())) throw new Error("Такой логин уже есть");
  if (!ROLES.includes(role)) throw new Error("Роль должна быть viewer, editor или admin");
  const pass = String(password ?? "");
  if (pass.length < 6) throw new Error("Пароль — минимум 6 символов");
  const user = {
    id: `u-${crypto.randomBytes(4).toString("hex")}`,
    login: name,
    passHash: hashPassword(pass),
    role,
    createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  persist();
  return publicUser(user);
}

function userById(id) {
  const user = loadUsers().users.find((u) => u.id === id);
  if (!user) throw new Error("Пользователь не найден");
  return user;
}

function adminsCount() {
  return loadUsers().users.filter((u) => u.role === "admin").length;
}

export function setUserPassword(id, password) {
  const pass = String(password ?? "");
  if (pass.length < 6) throw new Error("Пароль — минимум 6 символов");
  const user = userById(id);
  user.passHash = hashPassword(pass);
  // старые сессии пользователя больше не действуют
  for (const [token, s] of sessions) if (s.userId === user.id) sessions.delete(token);
  persist();
  return publicUser(user);
}

export function setUserRole(id, role) {
  if (!ROLES.includes(role)) throw new Error("Роль должна быть viewer, editor или admin");
  const user = userById(id);
  if (user.role === "admin" && role !== "admin" && adminsCount() <= 1) throw new Error("Нельзя убрать последнего администратора");
  user.role = role;
  persist();
  return publicUser(user);
}

export function removeUser(id) {
  const data = loadUsers();
  const user = userById(id);
  if (user.role === "admin" && adminsCount() <= 1) throw new Error("Нельзя удалить последнего администратора");
  data.users = data.users.filter((u) => u.id !== id);
  for (const [token, s] of sessions) if (s.userId === id) sessions.delete(token);
  persist();
  return { ok: true };
}
