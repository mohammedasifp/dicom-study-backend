import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDB, disconnectDB } from "../config/db.js";
import { ORTHANC_URL, ORTHANC_AUTH } from "../src/services/orthanc.js";
import { ingestOrthancStudy } from "../src/services/studies.js";

const [folder, flag] = process.argv.slice(2);
if (!folder) {
  console.error("Usage: npm run import-study -- <folder of DICOM files> [--no-ai]");
  process.exit(1);
}

async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

const studies = new Set();
for (const file of await filesIn(folder)) {
  const res = await fetch(`${ORTHANC_URL}/instances`, {
    method: "POST",
    headers: { "Content-Type": "application/dicom", ...(ORTHANC_AUTH && { Authorization: ORTHANC_AUTH }) },
    body: await readFile(file),
  });
  if (!res.ok) {
    console.warn(`[IMPORT] skipped ${file}: Orthanc ${res.status}`);
    continue;
  }
  studies.add((await res.json()).ParentStudy);
}

// With AI, leave the study to the Orthanc push so the running backend owns the analysis.
if (flag !== "--no-ai") {
  console.log(`[IMPORT] ${studies.size} study(ies) in Orthanc. The push reaches the backend in about 60 s and starts the AI.`);
  process.exit(0);
}

await connectDB();
for (const orthancId of studies) {
  const study = await ingestOrthancStudy(orthancId, { autoAnalyze: false, source: "import" });
  console.log(`[IMPORT] ${study.studyInstanceUid}: ${study.result}, status ${study.status}, AI not run`);
}
await disconnectDB();
