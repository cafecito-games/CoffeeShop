import { nodeKinds, type NodeKind } from "@coffee-shop/protocol";

export const BARISTA_ENVIRONMENT_FIELDS = [
  "CONTROL_ENDPOINT",
  "BARISTA_NAME",
  "BARISTA_ID",
  "BARISTA_KIND",
  "BARISTA_CONCURRENCY",
  "WORKSPACE_ROOTS",
  "COFFEE_SHOP_TOKEN"
] as const;

export interface OnboardingValues {
  controlEndpoint: string;
  name: string;
  nodeId: string;
  kind: NodeKind;
  concurrency: string;
  workspaceRoots: string;
}

export function defaultControlEndpoint(configured: string | undefined, development: boolean, origin: string): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  return development ? "http://localhost:8787" : origin;
}

export function workspaceRoots(value: string): string[] {
  return value.split(/\r?\n/).map((root) => root.trim()).filter(Boolean);
}

export function validateOnboarding(values: OnboardingValues): string[] {
  const errors: string[] = [];
  try {
    const endpoint = new URL(values.controlEndpoint);
    if (!(["http:", "https:"] as string[]).includes(endpoint.protocol) || !endpoint.hostname) throw new Error("unsupported URL");
  } catch {
    errors.push("Use an HTTP or HTTPS hub URL.");
  }
  if (!values.name.trim()) errors.push("Enter a Barista name.");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.nodeId)) errors.push("Use a lowercase ID containing only letters, numbers, and hyphens.");
  if (!(nodeKinds as readonly string[]).includes(values.kind)) errors.push("Choose a supported compute kind.");
  if (!/^[1-9]\d*$/.test(values.concurrency)) errors.push("Concurrency must be a positive integer.");
  const roots = workspaceRoots(values.workspaceRoots);
  if (!roots.length) errors.push("Enter at least one absolute workspace root.");
  else if (roots.some((root) => !isAbsolutePath(root))) errors.push("Every workspace root must be absolute.");
  return errors;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildBaristaCommand(values: OnboardingValues): string {
  const errors = validateOnboarding(values);
  if (errors.length) throw new Error(errors.join(" "));
  const environment: Record<typeof BARISTA_ENVIRONMENT_FIELDS[number], string> = {
    CONTROL_ENDPOINT: values.controlEndpoint.trim(),
    BARISTA_NAME: values.name.trim(),
    BARISTA_ID: values.nodeId,
    BARISTA_KIND: values.kind,
    BARISTA_CONCURRENCY: values.concurrency,
    WORKSPACE_ROOTS: workspaceRoots(values.workspaceRoots).join(","),
    COFFEE_SHOP_TOKEN: "replace-with-hub-token"
  };
  return [
    ...BARISTA_ENVIRONMENT_FIELDS.map((name) => `${name}=${shellQuote(environment[name])} \\`),
    "./bin/barista"
  ].join("\n");
}
