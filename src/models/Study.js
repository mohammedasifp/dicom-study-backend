import mongoose from "mongoose";
import { STUDY_STATUS } from "../constants/tags.js";

const instanceSchema = new mongoose.Schema(
  {
    sopInstanceUid: { type: String, required: true },
    instanceNumber: Number,
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
  },
  { _id: false }
);

const studySchema = new mongoose.Schema(
  {
    studyInstanceUid: { type: String, required: true, unique: true },
    orthancId: { type: String, required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    accessionNumber: String,
    modality: String,
    bodyPart: String,
    studyDate: String,
    description: String,
    series: [seriesSchema],
    status: { type: String, enum: Object.values(STUDY_STATUS), default: STUDY_STATUS.RECEIVED },
    viewed: {
      isViewed: { type: Boolean, default: false },
      viewedAt: Date,
      viewedBy: String,
      notViewedFlaggedAt: Date,
    },
    ai: {
      mode: String,
      requestedModel: String,
      prompt: String,
      model: { id: String, name: String, version: String },
      observations: [{ id: String, text: String, confidence: Number, localizable: Boolean }],
      uncertainty: String,
      limitations: [String],
      rois: [roiSchema],
      requestedAt: Date,
      completedAt: Date,
      error: String,
    },
  },
  { timestamps: true }
);

export default mongoose.model("Study", studySchema);
