import type { Clock } from '@incident-command-center/domain';

export class ManualClock implements Clock {
  #now: Date;

  constructor(instant: string | Date) {
    this.#now = new Date(instant);
  }

  now(): Date {
    return new Date(this.#now);
  }

  set(instant: string | Date): void {
    this.#now = new Date(instant);
  }
}

export class RecordingProvider<TInput, TOutput> {
  readonly calls: TInput[] = [];

  constructor(private readonly response: TOutput) {}

  async invoke(input: TInput): Promise<TOutput> {
    this.calls.push(input);
    return this.response;
  }
}
