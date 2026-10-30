import { Router } from "express";
import { isValidObjectId } from "mongoose";
import Study from "../models/Study.js";
import { syncFromOrthanc, getStudy, startAnalysis, retryStudy, rollbackAi, markViewed, setSla, assignRadiologist, deleteStudy, summary, reviewCounts, viewerUrl, DEFAULT_MODE } from "../services/studies.js";
import multer from "multer";
import { getReport, decideSuggestion, saveReport, finaliseReport, reopenReport, addReportImage, getReportImage, writePdf, MAX_IMAGE_BYTES } from "../services/reports.js";
import { AI_MODES } from "../constants/tags.js";
import { ok, HttpError } from "../utils/http.js";
import { actorName } from "../utils/auth.js";

const router = Router();
const MAX_PROMPT = 2000;
const withReviewer = (req) => ({ ...req.body, reviewer: actorName(req, req.body?.reviewer) });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

function pickMode(value) {
  const mode = value || DEFAULT_MODE;
  if (!AI_MODES.includes(mode)) throw new HttpError(400, `mode must be one of ${AI_MODES.join(", ")}`);
  return mode;
}

function pickPrompt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_PROMPT) throw new HttpError(400, `prompt must be text of at most ${MAX_PROMPT} characters`);
  return value.trim();
}

router.post("/sync", async (req, res) => ok(res, await syncFromOrthanc(), "synced"));

router.get("/", async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.viewed) filter["viewed.isViewed"] = req.query.viewed === "true";
  if (req.query.radiologist) {
    if (!isValidObjectId(req.query.radiologist)) throw new HttpError(400, "radiologist must be a radiologist id");
    filter["assignment.radiologist"] = req.query.radiologist;
  }
  const studies = await Study.find(filter).populate("patient").populate("assignment.radiologist").sort({ updatedAt: -1 }).limit(200).lean();
  const counts = await reviewCounts(studies.map((s) => s.studyInstanceUid));
  return ok(res, studies.map((s) => summary(s, counts.get(s.studyInstanceUid))));
});

router.get("/:uid", async (req, res) => {
  const study = await getStudy(req.params.uid);
  return ok(res, { ...study.toObject(), viewerUrl: viewerUrl(study.studyInstanceUid) });
});

router.delete("/:uid", async (req, res) => ok(res, await deleteStudy(req.params.uid, actorName(req)), "deleted"));

router.post("/:uid/analyze", async (req, res) => ok(res, await startAnalysis(req.params.uid, pickMode(req.body?.mode)), "analysis started", 202));

router.post("/:id/retry", async (req, res) =>
  ok(res, await retryStudy(req.params.id, { mode: pickMode(req.body?.mode), model: req.body?.model || undefined, prompt: pickPrompt(req.body?.prompt) }), "retry started", 202)
);

router.post("/:uid/ai/rollback", async (req, res) => ok(res, await rollbackAi(req.params.uid, { ...req.body, rolledBackBy: actorName(req, req.body?.rolledBackBy) }), "rolled back"));

router.put("/:uid/viewed", async (req, res) => ok(res, await markViewed(req.params.uid, actorName(req, req.body?.viewedBy))));

router.put("/:uid/sla", async (req, res) => ok(res, await setSla(req.params.uid, { ...req.body, setBy: actorName(req, req.body?.setBy) }), "sla set"));

router.put("/:uid/assignment", async (req, res) => {
  const study = await assignRadiologist(req.params.uid, { ...req.body, assignedBy: actorName(req, req.body?.assignedBy) });
  const counts = await reviewCounts([study.studyInstanceUid]);
  return ok(res, { ...study, review: counts.get(study.studyInstanceUid) || null }, "radiologist assigned");
});

router.get("/:uid/report", async (req, res) => {
  const study = await getStudy(req.params.uid);
  const report = await getReport(req.params.uid);
  return ok(res, { study: summary(study), ai: study.ai, report });
});

router.put("/:uid/report", async (req, res) => ok(res, await saveReport(req.params.uid, withReviewer(req)), "saved"));

router.patch("/:uid/report/suggestions/:observationId", async (req, res) =>
  ok(res, await decideSuggestion(req.params.uid, req.params.observationId, withReviewer(req)))
);

router.post("/:uid/report/finalise", async (req, res) => ok(res, await finaliseReport(req.params.uid, withReviewer(req)), "finalised"));

router.post("/:uid/report/reopen", async (req, res) => ok(res, await reopenReport(req.params.uid, withReviewer(req)), "reopened"));

router.post("/:uid/report/images", upload.single("file"), async (req, res) =>
  ok(res, await addReportImage(req.params.uid, { file: req.file, dataUrl: req.body?.dataUrl }), "image stored", 201)
);

router.get("/:uid/report/images/:imageId", async (req, res) => {
  const image = await getReportImage(req.params.uid, req.params.imageId);
  res.set({ "Content-Type": image.contentType, "Cache-Control": "private, max-age=86400" });
  return res.send(image.data);
});

router.get("/:uid/report/pdf", async (req, res) => writePdf(req.params.uid, res));

export default router;
