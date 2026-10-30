import mongoose from "mongoose";
import { CASE_STAGES, EXCEPTION_STATUS, EXCEPTION_TYPES, SEVERITIES, WORKFLOW_STAGES } from "../constants/ops.js";

const historySchema = new mongoose.Schema({ action: String, by: String, note: String, at: Date }, { _id: false });

const opsExceptionSchema = new mongoose.Schema(
  {
    dedupeKey: { type: String, required: true, index: true },
    type: { type: String, enum: Object.keys(EXCEPTION_TYPES), required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    stage: { type: String, enum: WORKFLOW_STAGES, required: true },
    caseStage: { type: String, enum: CASE_STAGES },
    status: { type: String, enum: Object.values(EXCEPTION_STATUS), default: EXCEPTION_STATUS.OPEN, index: true },
    ref: { kind: { type: String, enum: ["case", "study"] }, id: String },
    simulated: Boolean,
    patient: { patientId: String, name: String },
    accessionNumber: String,
    modality: String,
    description: String,
    priority: String,
    startedAt: Date,
    detectedAt: Date,
    detail: String,
    actions: [String],
    assignee: { id: String, name: String },
    assignedAt: Date,
    acknowledgedAt: Date,
    acknowledgedBy: String,
    resolvedAt: Date,
    resolvedBy: String,
    resolutionNote: String,
    clearedAt: Date,
    history: [historySchema],
  },
  { timestamps: true }
);

export default mongoose.model("OpsException", opsExceptionSchema);
