const ORTHANC_URL = process.env.ORTHANC_URL || "http://localhost:8042";
const AUTH =
  process.env.ORTHANC_USERNAME &&
  "Basic " + Buffer.from(`${process.env.ORTHANC_USERNAME}:${process.env.ORTHANC_PASSWORD || ""}`).toString("base64");

async function get(path) {
  const res = await fetch(`${ORTHANC_URL}${path}`, { headers: AUTH ? { Authorization: AUTH } : {} });
  if (!res.ok) throw new Error(`Orthanc ${path} -> ${res.status}`);
  return res;
}

const json = async (path) => (await get(path)).json();

export const getChanges = (since, limit = 100) => json(`/changes?since=${since}&limit=${limit}`);

export async function getStudy(orthancStudyId) {
  const study = await json(`/studies/${orthancStudyId}`);
  const patient = await json(`/studies/${orthancStudyId}/patient`);
  const series = await Promise.all(
    study.Series.map(async (id) => ({ ...(await json(`/series/${id}`)), instances: await json(`/series/${id}/instances`) }))
  );
  return { study, patient, series };
}

export async function getInstanceFile(orthancInstanceId) {
  return (await get(`/instances/${orthancInstanceId}/file`)).arrayBuffer();
}
