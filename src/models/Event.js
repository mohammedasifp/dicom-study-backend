import mongoose from "mongoose";
import { TAGS } from "../constants/tags.js";

const eventSchema = new mongoose.Schema(
  {
    tag: { type: String, enum: Object.values(TAGS), required: true },
    studyInstanceUid: { type: String, index: true },
    actor: { type: String, enum: ["system", "ai", "reviewer", "server", "webapp"], default: "system" },
    payload: mongoose.Schema.Types.Mixed,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export default mongoose.model("Event", eventSchema);
