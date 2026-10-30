import mongoose from "mongoose";

const patientSchema = new mongoose.Schema(
  {
    patientId: { type: String, required: true, unique: true },
    name: String,
    sex: String,
    birthDate: String,
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true }
);

export default mongoose.model("Patient", patientSchema);
