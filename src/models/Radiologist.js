import mongoose from "mongoose";
import { SUPPORTED_MODALITIES } from "../constants/tags.js";

const radiologistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    passwordHash: { type: String, select: false },
    email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    designation: String,
    subspecialty: String,
    modalities: [{ type: String, enum: SUPPORTED_MODALITIES }],
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true }
);

export default mongoose.model("Radiologist", radiologistSchema);
