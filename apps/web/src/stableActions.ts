export interface StableActionResponse<T> { ok: boolean; status: number; value?: T; error?: string }

const semanticDigest = (value: unknown) => JSON.stringify(value);

/** Keeps one action identity through transport uncertainty; only an authoritative outcome settles it. */
export class StableActions {
  private readonly pending = new Map<string, { digest: string; key: string }>();

  constructor(private readonly makeKey: () => string = () => crypto.randomUUID()) {}

  idempotencyKey(action: string, argumentsValue: unknown) {
    const digest = semanticDigest(argumentsValue);
    const prior = this.pending.get(action);
    if (prior && prior.digest === digest) return prior.key;
    const key = `web-${this.makeKey()}`;
    this.pending.set(action, { digest, key });
    return key;
  }

  settle(action: string) { this.pending.delete(action); }
  pendingKey(action: string) { return this.pending.get(action)?.key; }

  async submit<T>(action: string, argumentsValue: unknown, send: (idempotencyKey: string) => Promise<StableActionResponse<T>>) {
    const key = this.idempotencyKey(action, argumentsValue);
    const response = await send(key);
    // A response from the authority, including a closed 4xx refusal, settles uncertainty. A 5xx does not.
    if (response.ok || (response.status >= 400 && response.status < 500)) this.settle(action);
    return response;
  }
}
