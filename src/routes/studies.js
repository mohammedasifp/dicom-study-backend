import { Router } from "express";
import Study from "../models/Study.js";
import { syncFromOrthanc, getStudy, startAnalysis, retryStudy, markViewed, summary, viewerUrl, DEFAULT_MODE } from "../services/studies.js";
import { getReport, decideSuggestion, saveReport, finaliseReport, writePdf } from "../services/reports.js";
import { AI_MODES } from "../constants/tags.js";
import { ok, HttpError } from "../utils/http.js";

const router = Router();
const MAX_PROMPT = 2000;

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
  const studies = await Study.find(filter).populate("patient").sort({ updatedAt: -1 }).limit(200).lean();
  return ok(res, studies.map(summary));
});

router.get("/:uid", async (req, res) => {
  const study = await getStudy(req.params.uid);
  return ok(res, { ...study.toObject(), viewerUrl: viewerUrl(study.studyInstanceUid) });
});

router.post("/:uid/analyze", async (req, res) => ok(res, await startAnalysis(req.params.uid, pickMode(req.body?.mode)), "analysis started", 202));

router.post("/:id/retry", async (req, res) =>
  ok(res, await retryStudy(req.params.id, { mode: pickMode(req.body?.mode), model: req.body?.model || undefined, prompt: pickPrompt(req.body?.prompt) }), "retry started", 202)
);

router.put("/:uid/viewed", async (req, res) => ok(res, await markViewed(req.params.uid, req.body?.viewedBy)));

router.get("/:uid/report", async (req, res) => {
  const study = await getStudy(req.params.uid);
  const report = await getReport(req.params.uid);
  return ok(res, { study: summary(study), ai: study.ai, report });
});

router.put("/:uid/report", async (req, res) => ok(res, await saveReport(req.params.uid, req.body || {}), "saved"));

router.patch("/:uid/report/suggestions/:observationId", async (req, res) =>
  ok(res, await decideSuggestion(req.params.uid, req.params.observationId, req.body || {}))
);

router.post("/:uid/report/finalise", async (req, res) => ok(res, await finaliseReport(req.params.uid, req.body || {}), "finalised"));

router.get("/:uid/report/pdf", async (req, res) => writePdf(req.params.uid, res));

export default router;
