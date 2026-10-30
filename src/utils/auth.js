import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isValidObjectId } from "mongoose";
import Radiologist from "../models/Radiologist.js";
import { HttpError } from "./http.js";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SECRET = process.env.AUTH_SECRET || "see-better-dev-secret";
if (!process.env.AUTH_SECRET) console.warn("[AUTH] AUTH_SECRET is not set; using the development secret");

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function signToken(radiologistId) {
  const payload = Buffer.from(JSON.stringify({ sub: String(radiologistId), exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    return exp > Date.now() && isValidObjectId(sub) ? sub : null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "sb_session";
const COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: TOKEN_TTL_MS };

export const setSessionCookie = (res, token) => res.cookie(SESSION_COOKIE, token, COOKIE_OPTIONS);
export const clearSessionCookie = (res) => res.clearCookie(SESSION_COOKIE, { ...COOKIE_OPTIONS, maxAge: undefined });

function readCookie(req) {
  const pair = (req.get("Cookie") || "").split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return pair ? decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1)) : null;
}

export async function identify(req, res, next) {
  const header = req.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const cookie = readCookie(req);
  // GET-only: honouring the cookie on a write would open CSRF.
  const token = header || (["GET", "HEAD"].includes(req.method) ? cookie : null);
  if (!token) return next();
  const id = readToken(token);
  const radiologist = id && (await Radiologist.findOne({ _id: id, status: "ACTIVE" }).lean());
  if (!radiologist) throw new HttpError(401, "Session is not valid");
  if (header && header !== cookie) setSessionCookie(res, header);
  req.user = radiologist;
  return next();
}

export function requireSignedIn(req, res, next) {
  if (!req.user) throw new HttpError(401, "Sign in first");
  next();
}

export function verifyPushSecret(req, res, next) {
  const expected = process.env.ORTHANC_PUSH_SECRET;
  if (!expected) return next();
  const given = Buffer.from(req.get("X-Push-Secret") || "");
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    console.warn(`[ORTHANC] push refused from ${req.ip}: ${given.length ? "wrong" : "missing"} X-Push-Secret`);
    throw new HttpError(401, "Push secret is not valid");
  }
  next();
}
if (!process.env.ORTHANC_PUSH_SECRET) console.warn("[AUTH] ORTHANC_PUSH_SECRET is not set; /event/preregister accepts any caller");

export const actorName = (req, fallback) => req.user?.name || fallback;
