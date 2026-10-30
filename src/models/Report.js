import mongoose from "mongoose";
import { imageSourceSchema } from "./Study.js";

const suggestionSchema = new mongoose.Schema(
  {
    observationId: { type: String, required: true },
    aiText: { type: String, required: true },
    section: { type: String, enum: ["findings", "impression"], default: "findings" },
    title: String,
    limitation: String,
    confidence: Number,
    series: Number,
    instance: Number,
    source: imageSourceSchema,
    decision: { type: String, enum: ["pending", "accepted", "edited", "discarded"], default: "pending" },
    reviewerText: String,
    decidedAt: Date,
  },
  { _id: false }
);

const sectionSchema = new mongoose.Schema(
  {
    aiText: String,
    text: String,
    source: { type: String, enum: ["ai", "reviewer_edited", "reviewer"], default: "ai" },
  },
  { _id: false }
);

export const DRAFT_FIELDS = ["model", "suggestions", "findings", "impression", "body", "uncertainty", "limitations", "reviewer", "authorship", "computedAuthorship"];

const draftFields = () => ({
  model: { id: String, name: String, version: String },
  suggestions: [suggestionSchema],
  findings: sectionSchema,
  impression: sectionSchema,
  body: mongoose.Schema.Types.Mixed,
  uncertainty: String,
  limitations: [String],
  reviewer: String,
  authorship: { aiPercent: Number, humanPercent: Number, source: String, recordedAt: Date },
  computedAuthorship: { aiPercent: Number, humanPercent: Number, aiWords: Number, totalWords: Number, computedAt: Date },
});

const reportSchema = new mongoose.Schema(
  {
    studyInstanceUid: { type: String, required: true, unique: true },
    study: { type: mongoose.Schema.Types.ObjectId, ref: "Study", required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    ...draftFields(),
    previous: { ...draftFields(), savedAt: Date },
    disclaimer: String,
    status: { type: String, enum: ["draft", "final"], default: "draft" },
    finalisedAt: Date,
    history: [{ _id: false, finalisedAt: Date, reviewer: String, reopenedAt: Date, reopenedBy: String, reason: String }],
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
