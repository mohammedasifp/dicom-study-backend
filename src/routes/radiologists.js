import { Router } from "express";
import { isValidObjectId } from "mongoose";
import Radiologist from "../models/Radiologist.js";
import { ok, HttpError } from "../utils/http.js";

const router = Router();
const FIELDS = ["name", "email", "designation", "subspecialty", "modalities", "status"];

const initials = (name) =>
  name
    .replace(/^dr\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

const toView = (r) => ({ ...(r.toObject ? r.toObject() : r), id: String(r._id), initials: initials(r.name) });

function pick(body = {}) {
  return Object.fromEntries(FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
}

async function save(doc) {
  try {
    return await doc.save();
  } catch (err) {
    if (err.name === "ValidationError") throw new HttpError(400, err.message);
    if (err.code === 11000) throw new HttpError(409, "A radiologist with this email already exists");
    throw err;
  }
}

router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.modality) filter.modalities = req.query.modality;
  return ok(res, (await Radiologist.find(filter).sort({ name: 1 }).lean()).map(toView));
});

router.post("/", async (req, res) => ok(res, toView(await save(new Radiologist(pick(req.body)))), "created", 201));

router.patch("/:id", async (req, res) => {
  const radiologist = isValidObjectId(req.params.id) && (await Radiologist.findById(req.params.id));
  if (!radiologist) throw new HttpError(404, "Radiologist not found");
  radiologist.set(pick(req.body));
  return ok(res, toView(await save(radiologist)), "updated");
});

export async function currentRadiologist(req, res) {
  const id = req.get("X-User-Id");
  if (id && !isValidObjectId(id)) throw new HttpError(400, "X-User-Id must be a radiologist id");
  const radiologist = id ? await Radiologist.findById(id).lean() : await Radiologist.findOne({ status: "ACTIVE" }).sort({ createdAt: 1 }).lean();
  if (!radiologist) throw new HttpError(404, "No radiologist found");
  return ok(res, toView(radiologist));
}

export default router;
