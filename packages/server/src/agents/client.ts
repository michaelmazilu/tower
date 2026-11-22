import { dataPath, readData, writeData } from "./data";

const API = "https://api.elevenlabs.io";
/** Account credits. The owner's hard limit; the free plan holds 10000 and cannot go over. */
export const HARD_CAP = 9500;
const DEFAULT_CAP = 3500;
/** The free tier allows four concurrent requests. One is left spare. */
const MAX_IN_FLIGHT = 3;

export interface Usage {
  remote: number;
  estimate: number;
}

export class SpendLimitError extends Error {}

/**
 * Two meters, and the higher one wins: what the account reports (which lags)
 * and a persisted over-estimate of everything this code has asked for.
 */
export class CreditGuard {
  /** When the meter was last asked, whatever the answer. */
  lastReadAt = -Infinity;
  private remote?: number;
  private readonly cap: number;

  constructor(
    private readonly readRemote: () => Promise<number>,
    cap = DEFAULT_CAP,
    private readonly file = dataPath("usage.json"),
  ) {
    this.cap = Number.isFinite(cap) ? Math.min(HARD_CAP, cap) : DEFAULT_CAP;
  }

  /** True once a meter read has succeeded and no later read has failed. */
  get checked(): boolean {
    return this.remote !== undefined;
  }

  /** Call before every batch. A batch cannot spend until this has succeeded. */
  async refresh(): Promise<Usage> {
    this.lastReadAt = Date.now();
    let remote: number;
    try {
      remote = await this.readRemote();
    } catch (error) {
      this.remote = undefined;
      throw error;
    }
    if (!Number.isFinite(remote)) {
      this.remote = undefined;
      throw new SpendLimitError("Could not read ElevenLabs usage, so nothing will be spent.");
    }
    const estimate = Math.max(remote, readData<Partial<Usage>>(this.file, {}).estimate ?? 0);
    this.remote = remote;
    writeData(this.file, { remote, estimate });
    return { remote, estimate };
  }

  reserve(credits: number): void {
    if (this.remote === undefined) throw new SpendLimitError("Usage was not checked before this batch.");
    const used = Math.max(this.remote, readData<Partial<Usage>>(this.file, {}).estimate ?? 0);
    if (!(credits >= 0) || used + credits > this.cap) {
      throw new SpendLimitError(`Credit cap ${this.cap} would be passed (${used} used, ${credits} requested).`);
    }
    writeData(this.file, { remote: this.remote, estimate: used + credits });
  }
}

let inFlight = 0;
const waiting: (() => void)[] = [];

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((done) => waiting.push(done));
  else inFlight++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

export class ElevenLabs {
  readonly guard: CreditGuard;
  private batch?: Promise<Usage>;

  constructor(
    private readonly key: string,
    cap = Number(process.env.TOWERAI_CREDIT_CAP ?? DEFAULT_CAP),
    private readonly request = fetch,
  ) {
    this.guard = new CreditGuard(async () => {
      const usage = await this.json<{ character_count?: number }>("GET", "/v1/user/subscription", undefined, AbortSignal.timeout(8000));
      return usage.character_count ?? NaN;
    }, cap);
  }

  /** Null without a key, which means rules and cached audio only. */
  static fromEnv(cap?: number): ElevenLabs | null {
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    return key ? new ElevenLabs(key, cap) : null;
  }

  /**
   * One meter read per batch, where a batch is at most a minute. The meter is
   * rate limited, and between reads the local estimate carries the cap.
   *
   * Only the first read is waited for. Later reads run in the background, so a
   * decision never stalls on the meter (it can take seconds): until the new
   * reading lands, the last reading plus the local estimate, which only grows,
   * still enforce the cap. A failed read still blocks spending, as before.
   */
  async prepare(): Promise<void> {
    if (Date.now() - this.guard.lastReadAt >= 60_000) {
      this.batch = this.guard.refresh();
      // Background reads report failure through `guard.checked`, not as an unhandled rejection.
      this.batch.catch(() => undefined);
    }
    if (!this.guard.checked) await this.batch;
  }

  fetch(method: string, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return this.request(API + path, {
      method,
      headers: { "xi-api-key": this.key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  /** Multipart, so fetch writes the content type itself. */
  upload(path: string, form: FormData, signal: AbortSignal): Promise<Response> {
    return this.request(API + path, { method: "POST", headers: { "xi-api-key": this.key }, body: form, signal });
  }

  /** Keeps the meter warm, so that no live answer waits for it to be read. */
  watchMeter(): () => void {
    let timer: NodeJS.Timeout;
    let stopped = false;
    const poll = async () => {
      this.batch = this.guard.refresh();
      const ok = await this.batch.then(() => true, () => false);
      if (!stopped) timer = setTimeout(() => void poll(), ok ? 40_000 : 3_000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  async json<T>(method: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await this.fetch(method, path, body, signal);
    if (!response.ok) {
      throw new Error(`ElevenLabs ${method} ${path.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  /** Holds one of the account's concurrent slots. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return limited(work);
  }
}
