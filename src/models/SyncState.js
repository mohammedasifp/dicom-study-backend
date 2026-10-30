import mongoose from "mongoose";

const syncStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    lastSeq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("SyncState", syncStateSchema);
