import { vi } from "vitest";

// Test-only helper (not imported by app code): a fetch() stand-in that routes each request
// through `route` and returns just the Response surface our callers read.

export type FetchResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};
export type FetchRoute = (url: string, init?: RequestInit) => FetchResult;

export function makeFetchMock(route: FetchRoute) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = route(url, init);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? "",
      json: r.json ?? (async () => ({})),
      text: r.text ?? (async () => ""),
    };
  });
}

/** Number of calls whose URL ends with `path`. Accepts any fetch-shaped mock, not just makeFetchMock's. */
export const callsTo = (fetchMock: { mock: { calls: ReadonlyArray<readonly [string, ...unknown[]]> } }, path: string) =>
  fetchMock.mock.calls.filter(([url]) => url.endsWith(path)).length;
