/** Neutral account metadata and errors; record descriptions remain data. */
const COMMERCIAL = /\$\s?\d|upgrad|\bpric(?:e|es|ing)\b|\bplans?\b|\btiers?\b|\bsubscri|\bbilling\b|\b(?:Indie|Hobbyist|Developer|Business|Scale|Starter)\b|\/mo\b|per month|sign[ -]?up/i;
const DROP = /upgrade|pric(?:e|es|ing)|billing|subscription|sign_?up|^(current_)?tier$|^plan(_name|_url)?$|^hints$|^retry_url$|^retry_note$|^locked_fields$/i;
const NOTE = /^(note|notes|message|warning|.*_warning|.*_note|explanation|detail|reason)$/i;
const RECORDS = new Set(["results", "permits", "matches", "contractors", "jurisdictions", "decisions", "twins", "votes"]);

export function neutralError(status: number): string {
  if (status === 401) return "The supplied PermitStack credential was not accepted (HTTP 401).";
  if (status === 403) return "This request is not available for the connected account (HTTP 403).";
  if (status === 404) return "The requested record or dataset is not available (HTTP 404).";
  if (status === 429) return "The connected account has reached a request limit (HTTP 429).";
  return `PermitStack could not complete this request (HTTP ${status}).`;
}

export function sanitizeOutput(value: unknown, rewriteNotes = true): unknown {
  if (Array.isArray(value)) return value.map(v => sanitizeOutput(v, rewriteNotes));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (DROP.test(key)) continue;
      if (/(^|_)(applicants?|complainants?)(_|$)/i.test(key) || (/(^|_)(home)?owners?(_|$)/i.test(key) && key !== "owner_filed")) continue;
      if (rewriteNotes && typeof v === "string" && NOTE.test(key)) {
        const text = v.replace(/your plan/gi, "this account").split(/(?<=[.!?])\s+/).filter(s => !COMMERCIAL.test(s)).join(" ");
        if (text) out[key] = text;
      } else {
        out[key.replace(/^tier_window_/, "account_window_")] = sanitizeOutput(v, rewriteNotes && !RECORDS.has(key));
      }
    }
    return out;
  }
  if (typeof value === "string" && /permit-stack\.com\S*(#pricing|[?&]plan=)/i.test(value)) return undefined;
  return value;
}
