export const ORTHANC_URL = (process.env.ORTHANC_URL || "http://localhost:8042").replace(/\/+$/, "");
const AUTH =
  process.env.ORTHANC_USERNAME &&
  "Basic " + Buffer.from(`${process.env.ORTHANC_USERNAME}:${process.env.ORTHANC_PASSWORD || ""}`).toString("base64");
export const ORTHANC_AUTH = AUTH;
console.log(`[ORTHANC] ${ORTHANC_URL}, basic auth ${AUTH ? "set" : "not set"}`);

async function get(path, headers = {}) {
  const res = await fetch(`${ORTHANC_URL}${path}`, { headers: AUTH ? { ...headers, Authorization: AUTH } : headers });
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
  const firstInstance = series.find((s) => s.instances.length)?.instances[0];
  const instanceTags = firstInstance ? await json(`/instances/${firstInstance.ID}/simplified-tags`).catch(() => ({})) : {};
  return { study, patient, series, instanceTags };
}

export function fromStableStudyPayload(body) {
  return {
    study: { MainDicomTags: body.studyTags || {}, LastUpdate: body.lastUpdate },
    patient: { MainDicomTags: body.patient?.tags || {} },
    series: body.series.map((s) => ({
      ID: s.seriesId,
      MainDicomTags: s.tags || {},
      instances: (s.instances || []).map((i) => ({ ID: i.instanceId, MainDicomTags: i.tags || {} })),
    })),
    instanceTags: body.series.find((s) => s.instances?.length)?.instances[0].dicomTags || {},
  };
}

export async function getInstanceFile(orthancInstanceId) {
  return (await get(`/instances/${orthancInstanceId}/file`)).arrayBuffer();
}

export async function getRenderedJpeg(orthancInstanceId, size = 768, frame) {
  const path = frame ? `/instances/${orthancInstanceId}/frames/${frame - 1}/rendered` : `/instances/${orthancInstanceId}/rendered`;
  return (await get(`${path}?width=${size}&height=${size}`, { Accept: "image/jpeg" })).arrayBuffer();
}
