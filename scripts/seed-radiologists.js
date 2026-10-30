import { connectDB, disconnectDB } from "../config/db.js";
import Radiologist from "../src/models/Radiologist.js";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/utils/auth.js";

const newPassword = () => process.env.SEED_PASSWORD || randomBytes(12).toString("base64url");

const RADIOLOGISTS = [
  { username: "dr.kavya.rao", name: "Dr. Kavya Rao", subspecialty: "Neuro", modalities: ["CT", "MR"] },
  { username: "dr.arjun.menon", name: "Dr. Arjun Menon", subspecialty: "Body", modalities: ["CT", "MR", "US"] },
  { username: "dr.jhansi.reddy", name: "Dr. Jhansi Reddy", subspecialty: "MSK", modalities: ["CR", "DX", "MR"] },
  { username: "dr.sameer.khan", name: "Dr. Sameer Khan", subspecialty: "Chest", modalities: ["CR", "DX", "CT"] },
];

await connectDB();
for (const r of RADIOLOGISTS) {
  const password = newPassword();
  await Radiologist.updateOne({ username: r.username }, { $set: { ...r, passwordHash: hashPassword(password) }, $setOnInsert: { status: "ACTIVE" } }, { upsert: true });
  console.log(`[SEED] ${r.username}  ${process.env.SEED_PASSWORD ? "(SEED_PASSWORD)" : password}`);
}
await disconnectDB();
