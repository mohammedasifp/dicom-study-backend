import mongoose from "mongoose";
import { CASE_STAGES, EXCEPTION_TYPES } from "../constants/ops.js";

const centreCaseSchema = new mongoose.Schema(
  {
    caseNumber: { type: String, required: true, unique: true },
    patient: { patientId: String, name: String, age: Number, sex: String },
    accessionNumber: String,
    modality: String,
    description: String,
    priority: { type: String, enum: ["STAT", "URGENT", "ROUTINE"], default: "ROUTINE" },
    patientClass: { type: String, enum: ["OP", "IP", "ER"], default: "OP" },
    stage: { type: String, enum: CASE_STAGES, required: true, index: true },
    registeredAt: Date,
    scheduledAt: Date,
    acquiredAt: Date,
    pacsAt: Date,
    viewedAt: Date,
    reportedAt: Date,
    deliveredAt: Date,
    dueAt: Date,
    expectedImages: Number,
    receivedImages: Number,
    pacsPatient: { patientId: String, name: String },
    fault: { type: { type: String, enum: Object.keys(EXCEPTION_TYPES) }, injectedAt: Date },
  },
  { timestamps: true }
);

export default mongoose.model("CentreCase", centreCaseSchema);
