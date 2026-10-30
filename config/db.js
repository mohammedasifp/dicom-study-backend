import mongoose from "mongoose";

export async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  mongoose.connection.on("connected", () => console.log("[DB] connected"));
  mongoose.connection.on("error", (err) => console.error("[DB] error", err.message));
  mongoose.connection.on("disconnected", () => console.warn("[DB] disconnected"));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.connection.close();
}
