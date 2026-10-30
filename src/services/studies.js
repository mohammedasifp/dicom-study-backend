import Study from "../models/Study.js";
import Report, { DRAFT_FIELDS } from "../models/Report.js";
import Patient from "../models/Patient.js";
import ReportImage from "../models/ReportImage.js";
import SyncState from "../models/SyncState.js";
import Radiologist from "../models/Radiologist.js";
import * as orthanc from "./orthanc.js";
import { isValidObjectId } from "mongoose";
import { analyze, listModels } from "./aiClient.js";
import { assertAiAllowed } from "./aiGuard.js";
import { emit } from "./events.js";
import { TAGS, STUDY_STATUS, SUPPORTED_MODALITIES, AI_MODES, AI_FAILURE_REASON, DISCLAIMER } from "../constants/tags.js";
import { HttpError } from "../utils/http.js";
import { computeAuthorship } from "../utils/authorship.js";

const OHIF_VIEWER_URL = process.env.OHIF_VIEWER_URL || "/ohif/viewer";
const NOT_VIEWED_MINUTES = Number(process.env.SCAN_NOT_VIEWED_MINUTES) || 15;
const AUTO_ANALYZE = process.env.AUTO_ANALYZE !== "false";
export const DEFAULT_MODE = AI_MODES.includes(process.env.AI_MODE) ? process.env.AI_MODE : "chunk";

async function reject(studyInstanceUid, reason, orthancId, source = "poll") {
  console.warn(`[ORTHANC] ${source}: rejected study ${studyInstanceUid || orthancId}: ${reason}`);
  await emit(TAGS.STUDY_REJECTED, studyInstanceUid, { actor: "server", payload: { orthancId, reason } });
  return { studyInstanceUid, result: "rejected", reason };
}

const PRIORITY = { STAT: "STAT", HIGH: "URGENT", URGENT: "URGENT" };

const personName = (value) => value?.replace(/\^+/g, " ").trim() || undefined;

function technique(series) {
  const views = [...new Set(series.map((s) => s.MainDicomTags.SeriesDescription).filter(Boolean))];
  const images = series.reduce((n, s) => n + s.instances.length, 0);
  const { Modality, BodyPartExamined } = series[0].MainDicomTags;
  return `${Modality}${BodyPartExamined ? ` ${BodyPartExamined.toLowerCase()}` : ""}: ${series.length} series, ${images} images${views.length ? ` (${views.join(", ")})` : ""}.`;
}

let ingestQueue = Promise.resolve();

function serial(fn) {
  const run = ingestQueue.then(fn);
  ingestQueue = run.catch(() => {});
  return run;
}

export async function ingestOrthancStudy(orthancId, options) {
  return serial(async () => saveOrthancStudy(orthancId, await orthanc.getStudy(orthancId), options));
}

export function ingestPushedStudy(body) {
  if (!body?.studyId || !Array.isArray(body.series)) throw new HttpError(400, "Expected the Orthanc stable-study payload");
  const instances = body.series.reduce((n, s) => n + (s.instances?.length || 0), 0);
  console.log(`[ORTHANC] push received: Orthanc study ${body.studyId}, ${body.series.length} series / ${instances} instances`);
  return serial(() => saveOrthancStudy(body.studyId, orthanc.fromStableStudyPayload(body), { source: "push" }));
}

async function saveOrthancStudy(orthancId, { study: o, patient: p, series, instanceTags = {} }, { autoAnalyze = AUTO_ANALYZE, force = false, source = "poll" } = {}) {
  const uid = o.MainDicomTags.StudyInstanceUID;
  const pt = p.MainDicomTags;

  if (!pt.PatientID) return reject(uid, "Missing Patient ID", orthancId, source);
  const supported = series.filter((s) => SUPPORTED_MODALITIES.includes(s.MainDicomTags.Modality));
  if (!supported.length) {
    const found = [...new Set(series.map((s) => s.MainDicomTags.Modality))].join(", ");
    return reject(uid, `No supported modality (found ${found})`, orthancId, source);
  }

  const patient = await Patient.findOneAndUpdate(
    { patientId: pt.PatientID },
    { $setOnInsert: { patientId: pt.PatientID, name: pt.PatientName, sex: pt.PatientSex, birthDate: pt.PatientBirthDate } },
    { upsert: true, returnDocument: "after" }
  );

  const study = (await Study.findOne({ studyInstanceUid: uid })) || new Study({ studyInstanceUid: uid });
  const isNew = study.isNew;
  if (!isNew && !force && o.LastUpdate && study.orthancId === orthancId && study.orthancLastUpdate === o.LastUpdate) {
    console.log(`[ORTHANC] ${source}: study ${uid} unchanged (${study.status})`);
    return { studyInstanceUid: uid, result: "unchanged", status: study.status };
  }
  Object.assign(study, {
    orthancId,
    orthancLastUpdate: o.LastUpdate,
    patient: patient._id,
    accessionNumber: o.MainDicomTags.AccessionNumber,
    studyDate: o.MainDicomTags.StudyDate,
    studyTime: o.MainDicomTags.StudyTime,
    description: o.MainDicomTags.StudyDescription,
    referringPhysician: personName(o.MainDicomTags.ReferringPhysicianName),
    clinicalHistory: instanceTags.AdditionalPatientHistory?.trim() || undefined,
    technique: technique(supported),
    priority: PRIORITY[String(instanceTags.RequestedProcedurePriority || "").toUpperCase()] || "ROUTINE",
    modality: supported[0].MainDicomTags.Modality,
    bodyPart: supported[0].MainDicomTags.BodyPartExamined,
    series: supported.map((s) => ({
      seriesInstanceUid: s.MainDicomTags.SeriesInstanceUID,
      orthancId: s.ID,
      modality: s.MainDicomTags.Modality,
      bodyPart: s.MainDicomTags.BodyPartExamined,
      description: s.MainDicomTags.SeriesDescription,
      seriesNumber: Number(s.MainDicomTags.SeriesNumber) || undefined,
      instances: s.instances.map((i) => ({
        sopInstanceUid: i.MainDicomTags.SOPInstanceUID,
        instanceNumber: Number(i.MainDicomTags.InstanceNumber) || undefined,
        orthancId: i.ID,
      })),
    })),
  });
  await study.save();

  const instanceCount = study.series.reduce((n, s) => n + s.instances.length, 0);
  await emit(TAGS.STUDY_RECEIVED, uid, {
    actor: "server",
    payload: { orthancId, modality: study.modality, seriesCount: study.series.length, instanceCount, isNew },
  });
  const started = isNew && autoAnalyze ? await startAnalysis(uid, DEFAULT_MODE, { auto: true }) : null;
  console.log(
    `[ORTHANC] ${source}: study ${uid} ${isNew ? "created" : "updated"}: ${personName(pt.PatientName) || "unknown"} (${pt.PatientID}), ${study.modality}, ` +
      `${study.series.length} series / ${instanceCount} instances${started?.status === STUDY_STATUS.AI_PROCESSING ? "; AI analysis started" : ""}`
  );
  return { studyInstanceUid: uid, result: isNew ? "created" : "updated", status: started?.status ?? study.status };
}

let syncing = false;
let rerun = false;

export async function syncFromOrthanc() {
  if (syncing) {
    rerun = true;
    return { queued: true };
  }
  syncing = true;
  let ingested = 0;
  try {
    const state = (await SyncState.findOne({ key: "orthanc" })) || new SyncState({ key: "orthanc" });
    do {
      rerun = false;
      for (;;) {
        const page = await orthanc.getChanges(state.lastSeq);
        for (const change of page.Changes) {
          if (change.ChangeType === "StableStudy") {
            const { result } = await ingestOrthancStudy(change.ID, { source: "poll" });
            if (result === "created" || result === "updated") ingested++;
          }
          state.lastSeq = change.Seq;
          await state.save();
        }
        if (page.Done || !page.Changes.length) break;
      }
    } while (rerun);
    return { ingested, lastSeq: state.lastSeq };
  } finally {
    syncing = false;
  }
}

export const viewerUrl = (studyInstanceUid) => `${OHIF_VIEWER_URL}?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`;

export async function deleteStudy(studyInstanceUid, deletedBy) {
  const study = await getStudy(studyInstanceUid);
  if (study.status === STUDY_STATUS.AI_PROCESSING) throw new HttpError(409, "The AI is still analysing this study. Delete it once the analysis ends.");
  if (study.status === STUDY_STATUS.REPORTED) throw new HttpError(409, "This study has a finalised report. Reopen the report before deleting the study.");

  const patientId = study.patient._id;
  await Promise.all([Report.deleteOne({ studyInstanceUid }), ReportImage.deleteMany({ studyInstanceUid }), Study.deleteOne({ _id: study._id })]);
  if (!(await Study.exists({ patient: patientId }))) await Patient.deleteOne({ _id: patientId });

  await emit(TAGS.STUDY_DELETED, studyInstanceUid, { actor: "reviewer", payload: { deletedBy, orthancId: study.orthancId } });
  console.log(`[STUDY] ${studyInstanceUid} deleted by ${deletedBy || "unknown"}; the images stay in Orthanc`);
  return { studyInstanceUid };
}

export async function reviewCounts(studyInstanceUids) {
  const reports = await Report.find({ studyInstanceUid: { $in: studyInstanceUids } }, { studyInstanceUid: 1, "suggestions.decision": 1 }).lean();
  return new Map(
    reports.map((r) => [
      r.studyInstanceUid,
      { total: r.suggestions.length, decided: r.suggestions.filter((x) => x.decision !== "pending").length },
    ])
  );
}

export function summary(s, review) {
  return {
    studyInstanceUid: s.studyInstanceUid,
    viewerUrl: viewerUrl(s.studyInstanceUid),
    patient: s.patient,
    accessionNumber: s.accessionNumber,
    studyDate: s.studyDate,
    studyTime: s.studyTime,
    description: s.description,
    modality: s.modality,
    bodyPart: s.bodyPart,
    referringPhysician: s.referringPhysician,
    clinicalHistory: s.clinicalHistory,
    technique: s.technique,
    priority: s.priority,
    patientClass: s.patientClass,
    reportedAt: s.reportedAt,
    status: s.status,
    viewed: s.viewed,
    sla: s.sla,
    assignment: s.assignment,
    assignedTo: s.assignment?.radiologist ? String(s.assignment.radiologist._id ?? s.assignment.radiologist) : null,
    seriesCount: s.series.length,
    instanceCount: s.series.reduce((n, se) => n + se.instances.length, 0),
    model: s.ai?.model,
    ai: {
      requestedAt: s.ai?.requestedAt,
      completedAt: s.ai?.completedAt,
      error: s.ai?.error,
      failureReason: s.ai?.failureReason,
    },
    review: review || null,
    hasPreviousAi: !!s.previousAi?.completedAt,
    updatedAt: s.updatedAt,
  };
}

export async function getStudy(studyInstanceUid) {
  const study = await Study.findOne({ studyInstanceUid }).populate("patient").populate("assignment.radiologist");
  if (!study) throw new HttpError(404, "Study not found");
  return study;
}

async function assertCanAnalyze(study) {
  if (study.status === STUDY_STATUS.AI_PROCESSING) throw new HttpError(409, "Analysis already running");
  if (await Report.exists({ studyInstanceUid: study.studyInstanceUid, status: "final" })) {
    throw new HttpError(409, "Report already finalised");
  }
}

const draftOf = (report) => ({ ...Object.fromEntries(DRAFT_FIELDS.map((f) => [f, report[f]])), savedAt: new Date() });

async function snapshotDraft(studyInstanceUid) {
  const report = await Report.findOne({ studyInstanceUid });
  if (!report?.suggestions.length) return;
  report.previous = draftOf(report.toObject());
  await report.save();
}

export async function rollbackAi(studyInstanceUid, { rolledBackBy } = {}) {
  const study = await getStudy(studyInstanceUid);
  if (!study.previousAi?.completedAt) throw new HttpError(409, "No previous AI output to roll back to");
  await assertCanAnalyze(study);

  const { ai: current, previousAi: previous } = study.toObject();
  const currentDone = !!current?.completedAt;
  study.ai = previous;
  study.previousAi = currentDone ? current : undefined;
  study.status = STUDY_STATUS.REPORT_PENDING;
  await study.save();

  const report = await Report.findOne({ studyInstanceUid });
  if (report?.previous?.savedAt) {
    const doc = report.toObject();
    for (const f of DRAFT_FIELDS) report.set(f, doc.previous[f]);
    report.previous = currentDone ? draftOf(doc) : undefined;
    await report.save();
  } else {
    await createDraft(study, study.ai);
  }

  await emit(TAGS.AI_ROLLED_BACK, studyInstanceUid, {
    actor: "webapp",
    payload: { rolledBackBy, restoredModel: previous.model?.id, replacedModel: current?.model?.id },
  });
  return summary(study);
}

export async function startAnalysis(studyInstanceUid, mode, { model: requestedModel, prompt, auto = false } = {}) {
  const study = await getStudy(studyInstanceUid);
  await assertCanAnalyze(study);
  try {
    await assertAiAllowed(studyInstanceUid);
  } catch (err) {
    if (!auto) throw err;
    console.warn(`[AI] study ${studyInstanceUid} not analysed: ${err.message}`);
    study.status = STUDY_STATUS.AI_FAILED;
    study.ai = { mode, requestedAt: new Date(), error: err.message, failureReason: AI_FAILURE_REASON.PROCESSING_ERROR };
    await study.save();
    await emit(TAGS.AI_FAILED, studyInstanceUid, { actor: "server", payload: { error: err.message, guard: true } });
    return summary(study);
  }

  if (study.ai?.completedAt) {
    study.previousAi = study.toObject().ai;
    await snapshotDraft(studyInstanceUid);
  }
  study.status = STUDY_STATUS.AI_PROCESSING;
  study.ai = { mode, requestedModel, prompt, requestedAt: new Date() };
  await study.save();
  await emit(TAGS.AI_REQUESTED, studyInstanceUid, { payload: { mode, requestedModel, prompt } });

  console.log(`[AI] study ${studyInstanceUid} started: ${mode} mode, model ${requestedModel || "auto"}`);
  runAnalysis(study, mode, { model: requestedModel, prompt }).catch((err) => console.error("[AI] unhandled", err));
  return summary(study);
}

export async function retryStudy(id, { mode, model, prompt }) {
  const found = isValidObjectId(id) ? await Study.findById(id) : await Study.findOne({ studyInstanceUid: id });
  if (!found) throw new HttpError(404, "Study not found");
  await assertCanAnalyze(found);
  if (model) {
    const known = (await listModels()).find((m) => m.id === model);
    if (!known) throw new HttpError(400, `Unknown model ${model}`);
    if (!known.modalities.includes(found.modality)) throw new HttpError(400, `Model ${model} does not support modality ${found.modality}`);
  }

  try {
    await ingestOrthancStudy(found.orthancId, { autoAnalyze: false, force: true, source: "retry" });
  } catch (err) {
    throw new HttpError(502, `Could not re-fetch the study from Orthanc: ${err.message}`);
  }
  return startAnalysis(found.studyInstanceUid, mode, { model, prompt });
}

function failureReason(study, err) {
  if (err.message.startsWith("AI declined")) return AI_FAILURE_REASON.OUT_OF_SCOPE;
  if (!study.series.some((s) => s.instances.length) || /no images/i.test(err.message)) return AI_FAILURE_REASON.INCOMPLETE_STUDY;
  if (/does not support modality|no model/i.test(err.message)) return AI_FAILURE_REASON.NO_MODEL;
  return AI_FAILURE_REASON.PROCESSING_ERROR;
}

async function runAnalysis(study, mode, options) {
  const uid = study.studyInstanceUid;
  try {
    const result = await analyze(study, mode, options, (progress) =>
      emit(mode === "stream" ? TAGS.AI_STREAM_CHUNK : TAGS.AI_CHUNK_SENT, uid, { actor: "ai", payload: progress })
    );
    const seriesOf = new Map(study.series.flatMap((s) => s.instances.map((i) => [i.sopInstanceUid, s.seriesInstanceUid])));
    for (const o of result.observations) {
      if (o.source?.sopInstanceUid) o.source.seriesInstanceUid ??= seriesOf.get(o.source.sopInstanceUid);
    }

    console.log(`[AI] study ${uid} done: ${result.model?.id}, ${result.observations.length} observation(s), ${Math.round((Date.now() - study.ai.requestedAt) / 1000)} s`);
    study.ai = { mode, requestedModel: options.model, prompt: options.prompt, requestedAt: study.ai.requestedAt, ...result, completedAt: new Date() };
    study.status = STUDY_STATUS.REPORT_PENDING;
    await study.save();
    await createDraft(study, result);

    await emit(TAGS.AI_COMPLETED, uid, {
      actor: "ai",
      payload: { status: study.status, model: result.model, observations: result.observations.length },
    });
    await emit(TAGS.REPORT_PENDING, uid);
  } catch (err) {
    study.status = STUDY_STATUS.AI_FAILED;
    study.ai.error = err.message;
    study.ai.failureReason = failureReason(study, err);
    console.error(`[AI] study ${uid} failed (${study.ai.failureReason}): ${err.message}`);
    await study.save();
    await emit(TAGS.AI_FAILED, uid, { actor: "ai", payload: { error: err.message, failureReason: study.ai.failureReason } });
  }
}

function createDraft(study, result) {
  const suggestions = result.observations.map((o) => ({
    observationId: o.id,
    aiText: o.text,
    section: o.section,
    title: o.title,
    limitation: o.limitation,
    confidence: o.confidence,
    series: o.series,
    instance: o.instance,
    source: o.source,
  }));
  const impressionText = suggestions.some((s) => s.section === "impression") ? "" : result.impression || "";
  const findings = { aiText: result.findings || "", text: result.findings || "", source: "ai" };
  const impression = { aiText: impressionText, text: impressionText, source: "ai" };
  return Report.findOneAndUpdate(
    { studyInstanceUid: study.studyInstanceUid },
    {
      studyInstanceUid: study.studyInstanceUid,
      study: study._id,
      patient: study.patient,
      model: result.model,
      suggestions,
      findings,
      impression,
      computedAuthorship: computeAuthorship({ suggestions, findings, impression }),
      uncertainty: result.uncertainty,
      limitations: result.limitations,
      disclaimer: DISCLAIMER,
      status: "draft",
      $unset: { reviewer: 1, finalisedAt: 1, authorship: 1, body: 1 },
    },
    { upsert: true, returnDocument: "after" }
  );
}

export async function markViewed(studyInstanceUid, viewedBy) {
  const study = await getStudy(studyInstanceUid);
  if (!study.viewed.isViewed) {
    study.viewed.isViewed = true;
    study.viewed.viewedAt = new Date();
    study.viewed.viewedBy = viewedBy;
    await study.save();
    await emit(TAGS.SCAN_VIEWED, studyInstanceUid, { actor: "webapp", payload: { viewedBy } });
  }
  return summary(study);
}

export async function flagNotViewed() {
  const cutoff = new Date(Date.now() - NOT_VIEWED_MINUTES * 60 * 1000);
  const stale = await Study.find({
    "viewed.isViewed": false,
    "viewed.notViewedFlaggedAt": null,
    "ai.completedAt": { $lte: cutoff },
  });
  for (const study of stale) {
    study.viewed.notViewedFlaggedAt = new Date();
    await study.save();
    await emit(TAGS.SCAN_NOT_VIEWED, study.studyInstanceUid, {
      payload: { minutesSinceAi: Math.round((Date.now() - study.ai.completedAt) / 60000) },
    });
  }
}

function assertMinutes(minutes, field) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) throw new HttpError(400, `${field} must be a number above 0`);
}

async function getOpenStudy(studyInstanceUid) {
  const study = await getStudy(studyInstanceUid);
  if (study.status === STUDY_STATUS.REPORTED) throw new HttpError(409, "Report already finalised");
  return study;
}

function applySla(study, minutes, setBy) {
  const setAt = new Date();
  study.sla = { minutes, setAt, setBy, dueAt: new Date(setAt.getTime() + minutes * 60 * 1000) };
}

function emitSlaSet(study) {
  const { minutes, dueAt, setBy } = study.sla;
  return emit(TAGS.SLA_SET, study.studyInstanceUid, { actor: "webapp", payload: { minutes, dueAt, setBy } });
}

export async function setSla(studyInstanceUid, { minutes, setBy }) {
  assertMinutes(minutes, "minutes");
  const study = await getOpenStudy(studyInstanceUid);
  applySla(study, minutes, setBy);
  await study.save();
  await emitSlaSet(study);
  return summary(study);
}

async function unassignRadiologist(studyInstanceUid, unassignedBy) {
  const study = await getOpenStudy(studyInstanceUid);
  const previous = study.assignment?.radiologist?._id;
  study.assignment = undefined;
  await study.save();
  await emit(TAGS.RADIOLOGIST_UNASSIGNED, studyInstanceUid, { actor: "webapp", payload: { radiologistId: previous, unassignedBy } });
  return summary(study);
}

export async function assignRadiologist(studyInstanceUid, { radiologistId, tatMinutes, assignedBy }) {
  if (radiologistId === null) return unassignRadiologist(studyInstanceUid, assignedBy);
  if (!isValidObjectId(radiologistId)) throw new HttpError(400, "radiologistId must be a radiologist id");
  if (tatMinutes !== undefined) assertMinutes(tatMinutes, "tatMinutes");
  const radiologist = await Radiologist.findById(radiologistId);
  if (!radiologist) throw new HttpError(404, "Radiologist not found");
  if (radiologist.status !== "ACTIVE") throw new HttpError(400, "Radiologist is not active");
  const study = await getOpenStudy(studyInstanceUid);

  study.assignment = { radiologist: radiologist._id, assignedAt: new Date(), assignedBy };
  if (tatMinutes !== undefined) applySla(study, tatMinutes, assignedBy);
  await study.save();
  await emit(TAGS.RADIOLOGIST_ASSIGNED, studyInstanceUid, {
    actor: "webapp",
    payload: { radiologistId: radiologist._id, name: radiologist.name, assignedBy, tatMinutes },
  });
  if (tatMinutes !== undefined) await emitSlaSet(study);
  study.assignment.radiologist = radiologist;
  return summary(study);
}

export async function flagOverdue() {
  const due = await Study.find({
    "sla.dueAt": { $lte: new Date() },
    "sla.overdueAt": null,
    status: { $ne: STUDY_STATUS.REPORTED },
  });
  for (const study of due) {
    study.sla.overdueAt = new Date();
    await study.save();
    await emit(TAGS.REPORT_OVERDUE, study.studyInstanceUid, {
      payload: { status: study.status, minutes: study.sla.minutes, dueAt: study.sla.dueAt, overdueAt: study.sla.overdueAt },
    });
  }
}
