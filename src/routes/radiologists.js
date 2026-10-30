import { Router } from "express";
import { isValidObjectId } from "mongoose";
import Radiologist from "../models/Radiologist.js";
import { ok, HttpError } from "../utils/http.js";
import { clearSessionCookie, hashPassword, setSessionCookie, signToken, verifyPassword } from "../utils/auth.js";

const router = Router();
const FIELDS = ["name", "username", "email", "designation", "subspecialty", "modalities", "status"];

const initials = (name) =>
  name
    .replace(/^dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

const toView = (r) => {
  const { passwordHash: _p, ...rest } = r.toObject ? r.toObject() : r;
  return { ...rest, id: String(r._id), initials: initials(r.name) };
};

const MIN_PASSWORD = 6;

function requireUser(req, res, next) {
  if (!req.user) throw new HttpError(401, "Sign in to change radiologists");
  next();
}

function pick(body = {}) {
  const fields = Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
  if (body.password !== undefined) {
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD) throw new HttpError(400, `password must be text of at least ${MIN_PASSWORD} characters`);
    fields.passwordHash = hashPassword(body.password);
  }
  return fields;
}

async function save(doc) {
  try {
    return await doc.save();
  } catch (err) {
    if (err.name === "ValidationError") throw new HttpError(400, err.message);
    if (err.code === 11000) throw new HttpError(409, `A radiologist with this ${Object.keys(err.keyPattern || {})[0] || "value"} already exists`);
    throw err;
  }
}

router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.modality) filter.modalities = req.query.modality;
  return ok(res, (await Radiologist.find(filter).sort({ name: 1 }).lean()).map(toView));
});

router.post("/", requireUser, async (req, res) => ok(res, toView(await save(new Radiologist(pick(req.body)))), "created", 201));

router.patch("/:id", requireUser, async (req, res) => {
  const radiologist = isValidObjectId(req.params.id) && (await Radiologist.findById(req.params.id));
  if (!radiologist) throw new HttpError(404, "Radiologist not found");
  radiologist.set(pick(req.body));
  return ok(res, toView(await save(radiologist)), "updated");
});

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) throw new HttpError(400, "username and password are required");
  const radiologist = await Radiologist.findOne({ username, status: "ACTIVE" }).select("+passwordHash").lean();
  if (!radiologist || !verifyPassword(password, radiologist.passwordHash)) throw new HttpError(401, "Invalid username or password");
  const token = signToken(radiologist._id);
  setSessionCookie(res, token);
  return ok(res, { token, user: toView(radiologist) }, "signed in");
});

authRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  return ok(res, null, "signed out");
});

export async function currentRadiologist(req, res) {
  if (!req.user) throw new HttpError(401, "Not signed in");
  return ok(res, toView(req.user));
}

export default router;
