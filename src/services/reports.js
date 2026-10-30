import PDFDocument from "pdfkit";
import Report from "../models/Report.js";
import Study from "../models/Study.js";
import { emit } from "./events.js";
import { TAGS, STUDY_STATUS } from "../constants/tags.js";
import { HttpError } from "../utils/http.js";
import { computeAuthorship } from "../utils/authorship.js";

const DECISION_TAGS = {
  accepted: TAGS.SUGGESTION_ACCEPTED,
  edited: TAGS.SUGGESTION_EDITED,
  discarded: TAGS.SUGGESTION_DISCARDED,
};

export async function getReport(studyInstanceUid) {
  const report = await Report.findOne({ studyInstanceUid });
  if (!report) throw new HttpError(404, "No report for this study yet");
  return report;
}

async function getDraft(studyInstanceUid) {
  const report = await getReport(studyInstanceUid);
  if (report.status === "final") throw new HttpError(409, "Report already finalised");
  return report;
}

export async function decideSuggestion(studyInstanceUid, observationId, { decision, text, reviewer }) {
  if (!DECISION_TAGS[decision]) throw new HttpError(400, "decision must be accepted, edited or discarded");
  if (decision === "edited" && !text?.trim()) throw new HttpError(400, "text is required for an edited suggestion");

  const report = await getDraft(studyInstanceUid);
  const suggestion = report.suggestions.find((s) => s.observationId === observationId);
  if (!suggestion) throw new HttpError(404, "Suggestion not found");

  suggestion.decision = decision;
  suggestion.reviewerText = decision === "edited" ? text.trim() : undefined;
  suggestion.decidedAt = new Date();
  report.computedAuthorship = computeAuthorship(report);
  await report.save();
  await emit(DECISION_TAGS[decision], studyInstanceUid, { actor: "reviewer", payload: { observationId, reviewer } });
  return report;
}

function updateSection(section, text) {
  if (text === undefined) return;
  section.text = text;
  if (!section.aiText) section.source = "reviewer";
  else section.source = text === section.aiText ? "ai" : "reviewer_edited";
}

const isPercent = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

function parseAuthorship(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "authorship must be an object");
  let { aiPercent, humanPercent, source } = value;
  if (aiPercent === undefined && humanPercent === undefined) throw new HttpError(400, "authorship needs aiPercent or humanPercent");
  if (aiPercent !== undefined && !isPercent(aiPercent)) throw new HttpError(400, "aiPercent must be a number from 0 to 100");
  if (humanPercent !== undefined && !isPercent(humanPercent)) throw new HttpError(400, "humanPercent must be a number from 0 to 100");
  aiPercent ??= 100 - humanPercent;
  humanPercent ??= 100 - aiPercent;
  if (Math.abs(aiPercent + humanPercent - 100) > 0.5) throw new HttpError(400, "aiPercent and humanPercent must add up to 100");
  if (source !== undefined && (typeof source !== "string" || source.length > 50)) {
    throw new HttpError(400, "authorship.source must be text of at most 50 characters");
  }
  return { aiPercent, humanPercent, source: source?.trim() || undefined, recordedAt: new Date() };
}

export async function saveReport(studyInstanceUid, { findings, impression, reviewer, authorship }) {
  const parsedAuthorship = parseAuthorship(authorship);
  const report = await getDraft(studyInstanceUid);
  updateSection(report.findings, findings);
  updateSection(report.impression, impression);
  if (reviewer) report.reviewer = reviewer;
  if (parsedAuthorship) report.authorship = parsedAuthorship;
  report.computedAuthorship = computeAuthorship(report);
  await report.save();
  await emit(TAGS.REPORT_SAVED, studyInstanceUid, {
    actor: "reviewer",
    payload: { reviewer, authorship: parsedAuthorship, computedAuthorship: report.computedAuthorship },
  });
  return report;
}

export async function finaliseReport(studyInstanceUid, { reviewer, authorship }) {
  if (!reviewer?.trim()) throw new HttpError(400, "reviewer is required to finalise");
  const parsedAuthorship = parseAuthorship(authorship);
  const report = await getDraft(studyInstanceUid);
  const pending = report.suggestions.filter((s) => s.decision === "pending").map((s) => s.observationId);
  if (pending.length) throw new HttpError(409, `Undecided suggestions: ${pending.join(", ")}`);

  report.status = "final";
  report.reviewer = reviewer.trim();
  report.finalisedAt = new Date();
  if (parsedAuthorship) report.authorship = parsedAuthorship;
  report.computedAuthorship = computeAuthorship(report);
  await report.save();
  await Study.updateOne({ studyInstanceUid }, { status: STUDY_STATUS.REPORTED });
  await emit(TAGS.REPORT_FINALISED, studyInstanceUid, {
    actor: "reviewer",
    payload: { reviewer: report.reviewer, authorship: report.authorship, computedAuthorship: report.computedAuthorship },
  });
  return report;
}

const SOURCE_LABEL = { ai: "AI-generated", reviewer_edited: "AI-generated, edited by reviewer", reviewer: "Written by reviewer" };

export async function writePdf(studyInstanceUid, res) {
  const report = await getReport(studyInstanceUid);
  const study = await Study.findOne({ studyInstanceUid }).populate("patient").lean();
  const isFinal = report.status === "final";

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="report-${studyInstanceUid}.pdf"`);
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(16).text(isFinal ? "FINAL REVIEWED DRAFT" : "DRAFT - NOT REVIEWED", { align: "center" });
  doc.moveDown(0.5).fontSize(9).fillColor("red").text(report.disclaimer, { align: "center" }).fillColor("black");

  doc.moveDown().fontSize(11);
  doc.text(`Patient: ${study?.patient?.name || "-"} (${study?.patient?.patientId || "-"})   Accession: ${study?.accessionNumber || "-"}`);
  doc.text(`Modality: ${study?.modality || "-"}   Body part: ${study?.bodyPart || "-"}   Study date: ${study?.studyDate || "-"}`);
  doc.text(`Study Instance UID: ${studyInstanceUid}`);
  doc.text(`AI model: ${report.model?.name || "-"} (${report.model?.id || "-"} v${report.model?.version || "-"})`);
  if (isFinal) doc.text(`Reviewed by: ${report.reviewer} on ${report.finalisedAt.toISOString()}`);
  if (report.computedAuthorship?.totalWords) {
    const { aiPercent, humanPercent, aiWords, totalWords } = report.computedAuthorship;
    doc.text(`Authorship, measured: AI ${aiPercent}% / reviewer ${humanPercent}% (${aiWords} of ${totalWords} words from AI)`);
  }
  if (report.authorship?.aiPercent !== undefined) {
    const { aiPercent, humanPercent, source } = report.authorship;
    doc.text(`Authorship, reported: AI ${aiPercent}% / reviewer ${humanPercent}%${source ? ` (from ${source})` : ""}`);
  }

  doc.moveDown().fontSize(13).text("Observations");
  doc.fontSize(10);
  for (const s of report.suggestions) {
    if (s.decision === "discarded") continue;
    const text = s.decision === "edited" ? s.reviewerText : s.aiText;
    const label = s.decision === "edited" ? "AI, edited by reviewer" : s.decision === "accepted" ? "AI, accepted" : "AI, pending review";
    doc.text(`- ${text}  [${label}; confidence ${s.confidence ?? "-"}]`);
  }
  const discarded = report.suggestions.filter((s) => s.decision === "discarded").length;
  if (discarded) doc.fillColor("gray").text(`${discarded} AI suggestion(s) discarded by reviewer.`).fillColor("black");

  for (const [title, section] of [["Findings", report.findings], ["Impression", report.impression]]) {
    doc.moveDown().fontSize(13).text(`${title}  (${SOURCE_LABEL[section?.source] || "-"})`);
    doc.fontSize(10).text(section?.text || "-");
  }

  doc.moveDown().fontSize(13).text("Uncertainty and limitations");
  doc.fontSize(10).text(report.uncertainty || "-");
  for (const l of report.limitations || []) doc.text(`- ${l}`);

  doc.moveDown().fontSize(13).text("Source images");
  doc.fontSize(8);
  for (const se of study?.series || []) {
    doc.text(`Series ${se.seriesInstanceUid} (${se.modality}, ${se.instances.length} instances)`);
    const rois = (study.ai?.rois || []).filter((r) => se.instances.some((i) => i.sopInstanceUid === r.sopInstanceUid));
    for (const r of rois) doc.text(`   ROI for ${r.observationId} on instance ${r.sopInstanceUid}: x=${r.x} y=${r.y} w=${r.width} h=${r.height}`);
  }

  doc.end();
  await emit(TAGS.REPORT_EXPORTED, studyInstanceUid, { actor: "reviewer", payload: { status: report.status } });
}
