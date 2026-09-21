export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface MonitoringProviderPort<TPayload = unknown> {
  receive(payload: TPayload): Promise<void>;
}

export interface PagingProviderPort<TPage = unknown> {
  page(page: TPage): Promise<{ providerReference: string }>;
}
