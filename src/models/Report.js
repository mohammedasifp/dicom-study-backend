import mongoose from "mongoose";

const suggestionSchema = new mongoose.Schema(
  {
    observationId: { type: String, required: true },
    aiText: { type: String, required: true },
    confidence: Number,
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

const reportSchema = new mongoose.Schema(
  {
    studyInstanceUid: { type: String, required: true, unique: true },
    study: { type: mongoose.Schema.Types.ObjectId, ref: "Study", required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    model: { id: String, name: String, version: String },
    suggestions: [suggestionSchema],
    findings: sectionSchema,
    impression: sectionSchema,
    uncertainty: String,
    limitations: [String],
    disclaimer: String,
    status: { type: String, enum: ["draft", "final"], default: "draft" },
    reviewer: String,
    finalisedAt: Date,
    authorship: { aiPercent: Number, humanPercent: Number, source: String, recordedAt: Date },
    computedAuthorship: { aiPercent: Number, humanPercent: Number, aiWords: Number, totalWords: Number, computedAt: Date },
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
