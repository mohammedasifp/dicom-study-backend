import { HttpError } from "../utils/http.js";

const BLOCKED = [
  {
    reason: "general tasks that are not about this study, such as poems, code or news",
    pattern: /\b(poems?|poetry|songs?|lyrics|jokes?|recipes?|python|javascript|weather|stock prices?|cricket|football)\b|\bwrite (a |an |some |me )?(story|essay|code|program|script|email|letter)\b/i,
  },
  {
    reason: "attempts to change the AI rules or to read secrets",
    pattern: /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules?)\b|\b(system prompt|api[ -]?keys?|passwords?|secrets?|access tokens?)\b/i,
  },
  {
    reason: "treatment or prescription advice",
    pattern: /\b(prescri\w*|dosages?)\b|\bwhat (medicines?|medications?|drugs?|doses?|tablets?|treatment)\b|\b(medicines?|medications?|drugs?|tablets?) (should|to give|to take)\b/i,
  },
];

export function assertPromptAllowed(prompt) {
  const blocked = prompt && BLOCKED.find((b) => b.pattern.test(prompt));
  if (blocked) throw new HttpError(400, `Rejected: the AI accepts only instructions about this study and its report. It does not accept ${blocked.reason}.`);
}
