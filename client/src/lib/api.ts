import { QueryClient, type QueryFunction } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: string; messageFr?: string; code?: string };
    // The server sends English and, when it has one, French; show the chosen language.
    let fr = true;
    try {
      fr = (localStorage.getItem("lang") ?? "fr") === "fr";
    } catch {
      /* storage unavailable: keep French, the default */
    }
    throw new ApiError(res.status, (fr && d.messageFr) || d.message || res.statusText, d.code);
  }
  return data;
}

/** Call the API. Throws ApiError with the server's message on failure. */
export async function api<T = unknown>(method: string, url: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  return (await parse(res)) as T;
}

/** Build a URL with query parameters, skipping empty values. */
export function withQuery(url: string, params: Record<string, string | number | boolean | null | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${url}?${s}` : url;
}

const defaultQueryFn: QueryFunction = async ({ queryKey }) => {
  const url = queryKey[0] as string;
  const params = (queryKey[1] ?? {}) as Record<string, string | number | null | undefined>;
  return api("GET", withQuery(url, params));
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: defaultQueryFn,
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

/** After any change, refresh everything: the ledger touches most screens. */
export function invalidateAll() {
  return queryClient.invalidateQueries();
}
