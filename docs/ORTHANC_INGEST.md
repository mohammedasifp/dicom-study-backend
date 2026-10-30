# How the backend gets DICOM from Orthanc and creates patient entries

## Summary

Orthanc stores the images. The backend does not receive uploads. It **pulls** from Orthanc.

1. When a study is complete, Orthanc tells the backend "something changed". The message carries no data.
2. The backend then asks Orthanc: "What changed since the last time?"
3. The backend reads the study's DICOM tags from Orthanc.
4. The backend creates or updates the **patient** and creates the **visit** (one visit = one study).
5. The backend sends the study's images to the AI API for analysis.
6. The webapp opens the images directly in Orthanc's OHIF viewer.

The backend also asks Orthanc every 60 seconds, and once at startup. This catches any message that was lost while the backend was down.

## Step by step

### 1. A study arrives in Orthanc

Send DICOM to Orthanc in one of these ways:

- Drag and drop the files in Orthanc Explorer: `http://localhost:8042`
- HTTP: `POST http://localhost:8042/instances` with the `.dcm` file as the body
- DICOM C-STORE to port `4242`. The called AE title must be `SVAIM`.

### 2. Orthanc tells the backend that the study is complete

- Orthanc marks a study **stable** when no new instance arrives for `StableAge` seconds. Our config sets 15 seconds.
- On that event, the Orthanc script `callbackEvent.py` calls `POST http://host.docker.internal:4000/api/studies/sync`. `host.docker.internal` is how the container reaches the backend on the host machine. Set `BACKEND_SYNC_URL` on the container to change it.
- The call carries no study data. It only tells the backend to read the change list now.
- A new study therefore appears in the backend about 20 seconds after its last image arrives.
- If the backend is down, the call fails and Orthanc logs `backend sync notify failed`. Orthanc does not retry. The backend picks the study up at startup or at its next 60-second poll.

### 2a. The backend reads the change list

Orthanc keeps a numbered list of changes. Each change has a sequence number (`Seq`).

- The backend calls `GET /changes?since=<last Seq>&limit=100`.
- It acts only on `StableStudy` changes and skips the others.
- The backend saves the last `Seq` in MongoDB (collection `syncstates`). After a restart, it continues from that point and does not reprocess old studies.
- If Orthanc is down, the backend logs the error and tries again later. It does not skip the study.
- If a second "something changed" message arrives during a read, the backend reads the list once more when the first read ends.

### 3. The backend reads the study from Orthanc

For each stable study, the backend calls:

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
| `ORTHANC_URL` | `http://localhost:8042` | Orthanc REST address |
| `ORTHANC_USERNAME` / `ORTHANC_PASSWORD` | (none) | Orthanc basic-auth user. Use a user from `RegisteredUsers` in the Orthanc config. |
| `ORTHANC_POLL_MS` | `60000` | Time between safety-net polls of Orthanc |
| `AUTO_ANALYZE` | `true` | Start the AI analysis when a new visit arrives |
| `AI_MODE` | `chunk` | `stream` or `chunk` |
| `OHIF_VIEWER_URL` | `http://localhost:8042/ohif/viewer` | Base URL of the viewer link |

## Useful calls

- `POST /api/studies/sync`: read the Orthanc change list now. Orthanc's script calls this.
- `POST /api/studies/<id>/retry`: fetch the study from Orthanc again and re-run the AI. See the README for the body.
- `GET /api/patients/<PatientID>`: the patient with all visits and reports.
- `GET /api/studies?status=REPORT_PENDING`: the visits that wait for a report.
- `GET /api/events/stream`: SSE. It pushes `AI_COMPLETED` when the AI result for a visit is ready.

## Orthanc container notes

- The image needs `callbackEvent.py` at `/etc/orthanc/callbackEvent.py`. The Dockerfile copies it there. Without the file, Orthanc stops at startup with `Inexistent directory for the Python script`.
- Publish both ports: `-p 8042:8042 -p 4242:4242`.
- To enable the OHIF viewer and DICOMweb, set `OHIF_PLUGIN_ENABLED=true` and `DICOM_WEB_PLUGIN_ENABLED=true` on the `orthancteam/orthanc` image.
