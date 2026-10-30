# How the backend gets DICOM from Orthanc and creates patient entries

## Summary

Orthanc stores the images. The backend does not receive image uploads. Orthanc **pushes** each complete study to the backend, with all its DICOM tags.

1. When a study is complete, Orthanc sends the full study details to `POST /event/preregister`: the study, patient, series and instance tags.
2. The backend checks the study.
3. The backend creates or updates the **patient** and creates the **visit** (one visit = one study).
4. The backend downloads the study's images from Orthanc and sends them to the AI API for analysis.
5. The webapp opens the images directly in Orthanc's OHIF viewer.

**Safety net:** the backend also reads Orthanc's change list every 60 seconds, and once at startup. This catches any push that was lost while the backend was down. A study that did not change since the last ingest is skipped, so the push and the poll do not record it twice.

## Step by step

### 1. A study arrives in Orthanc

Send DICOM to Orthanc in one of these ways:

- Drag and drop the files in Orthanc Explorer: `http://localhost:8042`
- HTTP: `POST http://localhost:8042/instances` with the `.dcm` file as the body
- DICOM C-STORE to port `4242`. The called AE title must be `SVAIM`.

### 2. Orthanc pushes the study to the backend

- Orthanc marks a study **stable** when no new instance arrives for `StableAge` seconds. The new `SVAIMcOre.json` sets 60 seconds, so a study arrives about 60 seconds after its last image.
- On that event (`STABLE_STUDY`), the Orthanc script `callbackEvent.py` builds the full study details and sends them as JSON to `STUDY_API_HOST` + `STUDY_API_PATH`.
- The script reads the study from Orthanc's internal REST API, so it needs no Orthanc user.
- The payload holds:
  - `studyId` (Orthanc ID), `studyInstanceUid`, `studyTags`, `lastUpdate`
  - `patient.tags`
  - `series[]`: `seriesId`, `tags`, and `instances[]` with `instanceId`, `tags`, `dicomTags`, `metadata`
- The backend route is `POST /event/preregister`. It is outside `/api`, to match the script's path. Its JSON limit is 50 MB. All other routes keep the 1 MB limit.
- The backend maps the payload to the same shape as the pull (step 3), then saves it on the same path (steps 4 and 5).
- Replies:
  - `200` with `message` `created`, `updated` or `unchanged`, and `data: { studyInstanceUid, result, status }`. Orthanc logs `POST request successful (200)`.
  - `400` if the body is not the Orthanc payload.
  - `422` with the reason if the study is rejected (step 4). Orthanc logs `Failed request: 422 ...`.
- The script does not retry. If the backend is down, the push fails. The backend picks the study up at startup or at its next 60-second poll (step 2a).

### 2a. Safety net: the backend reads the change list

Orthanc keeps a numbered list of changes. Each change has a sequence number (`Seq`).

- The backend reads the list at startup, every `ORTHANC_POLL_MS`, and on `POST /api/studies/sync`.
- The backend calls `GET /changes?since=<last Seq>&limit=100`.
- It acts only on `StableStudy` changes and skips the others.
- The backend saves the last `Seq` in MongoDB (collection `syncstates`). After a restart, it continues from that point and does not reprocess old studies.
- If Orthanc is down, the backend logs the error and tries again later. It does not skip the study.
- If a sync request arrives during a read, the backend reads the list once more when the first read ends.
- A study that the push already saved, with the same Orthanc ID and the same Orthanc `LastUpdate`, is skipped as `unchanged`. It does not get a second `STUDY_RECEIVED`.
- The sync reply counts in `ingested` only the studies that were created or updated.
- All ingests, pushed or pulled, run one at a time. A push and a pull of the same study cannot overlap.

### 3. The backend reads the study from Orthanc (pull only)

A pushed study already holds these tags. For a study from the change list, the backend calls:

| Call | What the backend takes |
|---|---|
| `GET /studies/<id>` | StudyInstanceUID, AccessionNumber, StudyDate, StudyDescription |
| `GET /studies/<id>/patient` | PatientID, PatientName, PatientSex, PatientBirthDate |
| `GET /series/<id>` | SeriesInstanceUID, Modality, BodyPartExamined, SeriesDescription |
| `GET /series/<id>/instances` | SOPInstanceUID, InstanceNumber, and the Orthanc instance ID |

### 4. The backend checks the study

The backend rejects a study if one of these is true:

- The study has no PatientID.
- No series has a supported modality. The supported modalities are CR, DX (X-ray), CT, MR and US.

A rejected study gets a `STUDY_REJECTED` event with the reason. It does not get a patient or a visit.

The backend skips series with other modalities (for example SR or PR) and keeps the rest of the study.

### 5. The backend creates the patient and the visit

**Patient** (collection `patients`)

- One row for each **PatientID**.
- If the PatientID is new, the backend creates the row with the name, sex and birth date.
- If the PatientID already exists, the backend uses the existing row and does not change it.
- Result: when the same patient comes back for a second visit, the patient has one row and two visits.

**Visit** (collection `studies`)

- One row for each **StudyInstanceUID**.
- It holds: a link to the patient, the accession number, the study date, the modality, the body part, the series and instances (with their Orthanc IDs), and a status.
- The status of a new visit is `RECEIVED`.
- If Orthanc reports the same study as stable again (for example, more images arrived later), the backend updates the series list of the same visit. It does not create a second visit.
- The visit stores the Orthanc `LastUpdate` as `orthancLastUpdate`. If it did not change, the backend skips the study.

The backend then emits a `STUDY_RECEIVED` event.

### 6. The backend sends the images to the AI

- For a new visit, the analysis starts automatically. Set `AUTO_ANALYZE=false` to turn this off.
- The backend downloads each image from Orthanc with `GET /instances/<id>/file` and sends it to the AI API.
- Two modes are available. `AI_MODE` sets the default:
  - `stream`: all images in one request. The AI streams back its findings one by one.
  - `chunk`: images in batches of `AI_CHUNK_SIZE`, then one final result.
- The backend does not store image copies. Orthanc is the only store.

Visit status during the analysis:

```
RECEIVED -> AI_PROCESSING -> REPORT_PENDING  (AI finished, draft report created)
                          -> AI_FAILED       (AI error; re-run with POST /api/studies/<id>/retry)
REPORT_PENDING -> REPORTED                   (radiologist finalised the report)
```

### 7. The webapp views the images

Each visit has a `viewerUrl`:

```
http://localhost:8042/ohif/viewer?StudyInstanceUIDs=<StudyInstanceUID>
```

The webapp opens this URL. The images load from Orthanc directly, not through the backend. After the user opens the viewer, the webapp must call `PUT /api/studies/<uid>/viewed`.

## Settings (`config/dev.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ORTHANC_URL` | `http://localhost:8042` | Orthanc REST address, for the image files and the change list. With the new compose, use `http://localhost:8043`. |
| `ORTHANC_USERNAME` / `ORTHANC_PASSWORD` | (none) | Orthanc basic-auth user. Use a user from `RegisteredUsers` in the Orthanc config. The backend still needs it to download the images for the AI. |
| `ORTHANC_POLL_MS` | `60000` | Time between safety-net polls of Orthanc |
| `AUTO_ANALYZE` | `true` | Start the AI analysis when a new visit arrives |
| `AI_MODE` | `chunk` | `stream` or `chunk` |
| `OHIF_VIEWER_URL` | `http://localhost:8042/ohif/viewer` | Base URL of the viewer link |

## Useful calls

- `POST /event/preregister`: Orthanc's script pushes each stable study here.
- `POST /api/studies/sync`: read the Orthanc change list now (manual call, and the safety net).
- `POST /api/studies/<id>/retry`: fetch the study from Orthanc again and re-run the AI. See the README for the body.
- `GET /api/patients/<PatientID>`: the patient with all visits and reports.
- `GET /api/studies?status=REPORT_PENDING`: the visits that wait for a report.
- `GET /api/events/stream`: SSE. It pushes `AI_COMPLETED` when the AI result for a visit is ready, and `REPORT_OVERDUE` when a visit's SLA timer runs out.

## Orthanc container notes

- The image needs `callbackEvent.py` at `/etc/orthanc/callbackEvent.py`. The Dockerfile copies it there. Without the file, Orthanc stops at startup with `Inexistent directory for the Python script`.
- The script needs two variables on the Orthanc container:
  - `STUDY_API_HOST`: default `svaimbackendserver:8000`. For this backend, set `host.docker.internal:4000`.
  - `STUDY_API_PATH`: default `/event/preregister`. Keep it.
- In the compose file, add `extra_hosts: "host.docker.internal:host-gateway"` to the Orthanc service. Then the container can reach the backend on the host machine.
- The new compose maps Orthanc to host ports `8043` (HTTP) and `4243` (DICOM). Set the backend's `ORTHANC_URL=http://localhost:8043`. In step 1, use port `8043` instead of `8042` and DICOM port `4243` instead of `4242`.
- The new `SVAIMcOre.json` sets `StableAge` to 60 seconds.
- The new compose also has a dummy Python backend (`server.py`). It only prints and saves the payload. This backend replaces it.
- With a plain `docker run`, publish both ports: `-p 8042:8042 -p 4242:4242`.
- To enable the OHIF viewer and DICOMweb, set `OHIF_PLUGIN_ENABLED=true` and `DICOM_WEB_PLUGIN_ENABLED=true` on the `orthancteam/orthanc` image.
