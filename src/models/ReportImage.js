import mongoose from "mongoose";

const reportImageSchema = new mongoose.Schema(
  {
    studyInstanceUid: { type: String, required: true, index: true },
    contentType: { type: String, required: true },
    size: Number,
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

export default mongoose.model("ReportImage", reportImageSchema);
