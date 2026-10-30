export const CASE_STAGES = ["REGISTERED", "ACQUIRED", "IN_PACS", "REPORTED", "DELIVERED"];

export const WORKFLOW_STAGES = ["ACQUISITION", "PACS_TRANSFER", "REPORTING", "DELIVERY"];

export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export const EXCEPTION_STATUS = Object.freeze({ OPEN: "OPEN", ACKNOWLEDGED: "ACKNOWLEDGED", RESOLVED: "RESOLVED" });

export const SLA_TARGET_MINUTES = { STAT: 60, URGENT: 240, ROUTINE: 24 * 60 };

const minutes = (name, fallback) => Number(process.env[name]) || fallback;

export const THRESHOLDS = {
  scanGrace: minutes("OPS_SCAN_GRACE_MINUTES", 30),
  pacsGrace: minutes("OPS_PACS_GRACE_MINUTES", 15),
  partialGrace: minutes("OPS_PARTIAL_GRACE_MINUTES", 10),
  notViewed: minutes("OPS_NOT_VIEWED_MINUTES", 30),
  deliveryGrace: minutes("OPS_DELIVERY_GRACE_MINUTES", 60),
};

export const EXCEPTION_TYPES = {
  MISSED_SCAN: {
    stage: "ACQUISITION",
    severity: "HIGH",
    escalateAfter: 90,
    actions: [
      "Check whether the patient has arrived and is in the waiting area.",
      "If the patient is here, move them into the next free slot on this modality.",
      "If the patient has not come, call them to reschedule and update the order.",
    ],
  },
  PACS_TRANSFER_STUCK: {
    stage: "PACS_TRANSFER",
    severity: "HIGH",
    escalateAfter: 45,
    actions: [
      "Check the modality's send queue for failed jobs and re-send the study.",
      "Confirm the modality can reach PACS (network, AE title, port).",
      "If re-sending fails, raise it with the PACS administrator.",
    ],
  },
  PARTIAL_TRANSFER: {
    stage: "PACS_TRANSFER",
    severity: "MEDIUM",
    escalateAfter: 40,
    actions: [
      "Re-send the missing series from the modality.",
      "Check the modality log for transfer errors.",
      "Hold reporting until the study is complete in PACS.",
    ],
  },
  ID_MISMATCH: {
    stage: "PACS_TRANSFER",
    severity: "CRITICAL",
    escalateAfter: 30,
    actions: [
      "Do not report this study until the patient's identity is confirmed.",
      "Check the patient ID and name against the registration record and the modality worklist entry.",
      "Correct the DICOM header in PACS, or re-send from the modality, and record the correction.",
    ],
  },
  NOT_VIEWED: {
    stage: "REPORTING",
    severity: "MEDIUM",
    escalateAfter: 60,
    actions: [
      "Check that the study is assigned to a radiologist who is on shift.",
      "Reassign it if the assigned radiologist is busy.",
      "For STAT studies, call the radiologist directly.",
    ],
  },
  REPORT_OVERDUE: {
    stage: "REPORTING",
    severity: "HIGH",
    escalateAfter: 60,
    actions: [
      "Ask the assigned radiologist for an expected completion time.",
      "Reassign to a radiologist with capacity.",
      "Tell the referring doctor if the delay affects care.",
    ],
  },
  DELIVERY_PENDING: {
    stage: "DELIVERY",
    severity: "LOW",
    escalateAfter: 120,
    actions: [
      "Check the delivery channel (WhatsApp, email or print counter) for a failed send.",
      "Send the report again, or hand it over at the desk.",
      "Call the patient if their contact details are missing.",
    ],
  },
};

export const DEFAULT_INJECTIONS = ["MISSED_SCAN", "PACS_TRANSFER_STUCK", "ID_MISMATCH", "NOT_VIEWED", "REPORT_OVERDUE"];

export const DEMO_CONTROLS = process.env.OPS_DEMO_CONTROLS === "true";

export const OPS_DISCLAIMER =
  "Suggested actions only. Staff review each one and decide what to do. Nothing is changed automatically.";
