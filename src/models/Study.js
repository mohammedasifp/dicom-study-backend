import mongoose from "mongoose";
import { AI_FAILURE_REASON, STUDY_STATUS } from "../constants/tags.js";

const instanceSchema = new mongoose.Schema(
  {
    sopInstanceUid: { type: String, required: true },
    instanceNumber: Number,
    frames: Number,
    orthancId: { type: String, required: true },
  },
  { _id: false }
);

const seriesSchema = new mongoose.Schema(
  {
    seriesInstanceUid: { type: String, required: true },
    orthancId: String,
    modality: String,
    bodyPart: String,
    description: String,
    seriesNumber: Number,
    instances: [instanceSchema],
  },
  { _id: false }
);

const roiSchema = new mongoose.Schema(
  {
    observationId: String,
    sopInstanceUid: String,
    x: Number,
    y: Number,
    width: Number,
    height: Number,
    shape: { type: String, enum: ["rect", "ellipse"], default: "rect" },
    imageWidth: Number,
    imageHeight: Number,
  },
  { _id: false }
);

export const imageSourceSchema = new mongoose.Schema({ seriesInstanceUid: String, sopInstanceUid: String, frame: Number }, { _id: false });

const observationSchema = new mongoose.Schema(
  {
    id: String,
    section: { type: String, enum: ["findings", "impression"], default: "findings" },
    title: String,
    text: String,
    confidence: Number,
    localizable: Boolean,
    limitation: String,
    series: Number,
    instance: Number,
    source: imageSourceSchema,
  },
  { _id: false }
);

const aiFields = () => ({
  mode: String,
  requestedModel: String,
  prompt: String,
  model: { id: String, name: String, version: String },
  observations: [observationSchema],
  uncertainty: String,
  limitations: [String],
  rois: [roiSchema],
  requestedAt: Date,
  completedAt: Date,
  error: String,
  failureReason: { type: String, enum: Object.values(AI_FAILURE_REASON) },
});

const studySchema = new mongoose.Schema(
  {
    studyInstanceUid: { type: String, required: true, unique: true },
    orthancId: { type: String, required: true },
    orthancLastUpdate: String,
    patient: { type: mongoose.Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    accessionNumber: String,
    modality: String,
    bodyPart: String,
    studyDate: String,
    studyTime: String,
    description: String,
    referringPhysician: String,
    clinicalHistory: String,
    technique: String,
    priority: { type: String, enum: ["STAT", "URGENT", "ROUTINE"], default: "ROUTINE" },
    patientClass: { type: String, enum: ["OP", "IP", "ER"], default: "OP" },
    reportedAt: Date,
    series: [seriesSchema],
    status: { type: String, enum: Object.values(STUDY_STATUS), default: STUDY_STATUS.RECEIVED },
    viewed: {
      isViewed: { type: Boolean, default: false },
      viewedAt: Date,
      viewedBy: String,
      notViewedFlaggedAt: Date,
    },
    sla: {
      minutes: Number,
      setAt: Date,
      setBy: String,
      dueAt: Date,
      overdueAt: Date,
    },
    assignment: {
      radiologist: { type: mongoose.Schema.Types.ObjectId, ref: "Radiologist", index: true },
      assignedAt: Date,
      assignedBy: String,
    },
    ai: aiFields(),
    previousAi: aiFields(),
  },
  { timestamps: true }
);

export default mongoose.model("Study", studySchema);
