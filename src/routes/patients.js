import { Router } from "express";
import Patient from "../models/Patient.js";
import Study from "../models/Study.js";
import Report from "../models/Report.js";
import { summary } from "../services/studies.js";
import { ok, HttpError } from "../utils/http.js";

const router = Router();

router.get("/", async (req, res) => ok(res, await Patient.find().sort({ updatedAt: -1 }).limit(200).lean()));

router.get("/:patientId", async (req, res) => {
  const patient = await Patient.findOne({ patientId: req.params.patientId }).lean();
  if (!patient) throw new HttpError(404, "Patient not found");
  const studies = await Study.find({ patient: patient._id }).populate("patient").populate("assignment.radiologist").sort({ createdAt: -1 }).lean();
  const reports = await Report.find({ patient: patient._id }).select("studyInstanceUid status reviewer finalisedAt").lean();
  return ok(res, { patient, visits: studies.map(summary), reports });
});

export default router;
