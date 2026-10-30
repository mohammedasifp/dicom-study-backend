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

export async function identify(req, res, next) {
  const token = req.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return next();
  const id = readToken(token);
  const radiologist = id && (await Radiologist.findOne({ _id: id, status: "ACTIVE" }).lean());
  if (!radiologist) throw new HttpError(401, "Session is not valid");
  req.user = radiologist;
  return next();
}

export const actorName = (req, fallback) => req.user?.name || fallback;
