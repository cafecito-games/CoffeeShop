/*
 * Secret redaction for harness-produced text. Barista already removes the run's own credentials;
 * the hub additionally removes its enrollment token and common credential shapes before anything
 * is persisted or broadcast. Identity fields cannot be rewritten without changing what they
 * identify, so a secret there makes the value unsafe to publish at all.
 */
export const redactionMarker = "[redacted]";

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
];

const bearerCredential = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gi;

export interface Redactor {
  redact(value: string): string;
  containsSecret(value: string): boolean;
}

export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const exact = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 8))]
    .sort((left, right) => right.length - left.length);
  const redact = (value: string) => {
    let result = value;
    for (const secret of exact) result = result.split(secret).join(redactionMarker);
    for (const pattern of secretPatterns) result = result.replace(pattern, redactionMarker);
    return result.replace(bearerCredential, (_match, scheme: string) => `${scheme} ${redactionMarker}`);
  };
  return { redact, containsSecret: (value) => redact(value) !== value };
}
