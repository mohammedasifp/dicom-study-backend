import Study from "../models/Study.js";
import Report from "../models/Report.js";
import Patient from "../models/Patient.js";
import SyncState from "../models/SyncState.js";
import * as orthanc from "./orthanc.js";
import { isValidObjectId } from "mongoose";
import { analyze, listModels } from "./aiClient.js";
import { emit } from "./events.js";
import { TAGS, STUDY_STATUS, SUPPORTED_MODALITIES, AI_MODES, DISCLAIMER } from "../constants/tags.js";
import { HttpError } from "../utils/http.js";
import { computeAuthorship } from "../utils/authorship.js";

const OHIF_VIEWER_URL = process.env.OHIF_VIEWER_URL || "http://localhost:8042/ohif/viewer";
const NOT_VIEWED_MINUTES = Number(process.env.SCAN_NOT_VIEWED_MINUTES) || 15;
const AUTO_ANALYZE = process.env.AUTO_ANALYZE !== "false";
export const DEFAULT_MODE = AI_MODES.includes(process.env.AI_MODE) ? process.env.AI_MODE : "chunk";

async function reject(studyInstanceUid, reason, orthancId) {
  console.warn(`[ORTHANC] rejected study ${studyInstanceUid || orthancId}: ${reason}`);
  await emit(TAGS.STUDY_REJECTED, studyInstanceUid, { actor: "server", payload: { orthancId, reason } });
}

export async function ingestOrthancStudy(orthancId, { autoAnalyze = AUTO_ANALYZE } = {}) {
  const { study: o, patient: p, series } = await orthanc.getStudy(orthancId);
  const uid = o.MainDicomTags.StudyInstanceUID;
  const pt = p.MainDicomTags;

  if (!pt.PatientID) return reject(uid, "Missing Patient ID", orthancId);
  const supported = series.filter((s) => SUPPORTED_MODALITIES.includes(s.MainDicomTags.Modality));
  if (!supported.length) {
    const found = [...new Set(series.map((s) => s.MainDicomTags.Modality))].join(", ");
    return reject(uid, `No supported modality (found ${found})`, orthancId);
  }

  const patient = await Patient.findOneAndUpdate(
    { patientId: pt.PatientID },
    { $setOnInsert: { patientId: pt.PatientID, name: pt.PatientName, sex: pt.PatientSex, birthDate: pt.PatientBirthDate } },
    { upsert: true, returnDocument: "after" }
  );

  const study = (await Study.findOne({ studyInstanceUid: uid })) || new Study({ studyInstanceUid: uid });
  const isNew = study.isNew;
  Object.assign(study, {
    orthancId,
    patient: patient._id,
    accessionNumber: o.MainDicomTags.AccessionNumber,
    studyDate: o.MainDicomTags.StudyDate,
    description: o.MainDicomTags.StudyDescription,
    modality: supported[0].MainDicomTags.Modality,
    bodyPart: supported[0].MainDicomTags.BodyPartExamined,
    series: supported.map((s) => ({
      seriesInstanceUid: s.MainDicomTags.SeriesInstanceUID,
      orthancId: s.ID,
      modality: s.MainDicomTags.Modality,
      bodyPart: s.MainDicomTags.BodyPartExamined,
      description: s.MainDicomTags.SeriesDescription,
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
  if (isNew && autoAnalyze) await startAnalysis(uid, DEFAULT_MODE);
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
            await ingestOrthancStudy(change.ID);
            ingested++;
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

export function summary(s) {
  return {
    studyInstanceUid: s.studyInstanceUid,
    viewerUrl: viewerUrl(s.studyInstanceUid),
    patient: s.patient,
    accessionNumber: s.accessionNumber,
    studyDate: s.studyDate,
    modality: s.modality,
    bodyPart: s.bodyPart,
    status: s.status,
    viewed: s.viewed,
    seriesCount: s.series.length,
    instanceCount: s.series.reduce((n, se) => n + se.instances.length, 0),
    model: s.ai?.model,
    updatedAt: s.updatedAt,
  };
}

export async function getStudy(studyInstanceUid) {
  const study = await Study.findOne({ studyInstanceUid }).populate("patient");
  if (!study) throw new HttpError(404, "Study not found");
  return study;
}

async function assertCanAnalyze(study) {
  if (study.status === STUDY_STATUS.AI_PROCESSING) throw new HttpError(409, "Analysis already running");
  if (await Report.exists({ studyInstanceUid: study.studyInstanceUid, status: "final" })) {
    throw new HttpError(409, "Report already finalised");
  }
}

export async function startAnalysis(studyInstanceUid, mode, { model: requestedModel, prompt } = {}) {
  const study = await getStudy(studyInstanceUid);
  await assertCanAnalyze(study);

  study.status = STUDY_STATUS.AI_PROCESSING;
  study.ai = { mode, requestedModel, prompt, requestedAt: new Date() };
  await study.save();
  await emit(TAGS.AI_REQUESTED, studyInstanceUid, { payload: { mode, requestedModel, prompt } });

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
    await ingestOrthancStudy(found.orthancId, { autoAnalyze: false });
  } catch (err) {
    throw new HttpError(502, `Could not re-fetch the study from Orthanc: ${err.message}`);
  }
  return startAnalysis(found.studyInstanceUid, mode, { model, prompt });
}

async function runAnalysis(study, mode, options) {
  const uid = study.studyInstanceUid;
  try {
    const result = await analyze(study, mode, options, (progress) =>
      emit(mode === "stream" ? TAGS.AI_STREAM_CHUNK : TAGS.AI_CHUNK_SENT, uid, { actor: "ai", payload: progress })
    );

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
    await study.save();
    await emit(TAGS.AI_FAILED, uid, { actor: "ai", payload: { error: err.message } });
  }
}

function createDraft(study, result) {
  const suggestions = result.observations.map((o) => ({ observationId: o.id, aiText: o.text, confidence: o.confidence }));
  const findings = { aiText: result.findings, text: result.findings, source: "ai" };
  const impression = { aiText: result.impression, text: result.impression, source: "ai" };
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
      $unset: { reviewer: 1, finalisedAt: 1, authorship: 1 },
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
