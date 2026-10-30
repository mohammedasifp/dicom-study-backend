export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function ok(res, data, message = "success", status = 200) {
  return res.status(status).json({ code: 0, message, data });
}
