import { useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, invalidateAll } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Short stable hash of the request, so a repeat of the same submit reuses its key. */
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * POST/PUT/PATCH/DELETE helper: shows the server's message on error, refreshes data on success.
 * Each submit carries an Idempotency-Key, so a double tap or a network retry is recorded once.
 */
export function useApiMutation<TBody = unknown, TResult = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string | ((body: TBody) => string),
  opts: {
    success?: string;
    onSuccess?: (result: TResult, body: TBody) => void;
    /** A page that shows an error itself (on the field it is about) returns true, and no toast covers the form. */
    onError?: (error: Error, body: TBody) => boolean | void;
  } = {},
) {
  const { toast } = useToast();
  // Changes after each success, so the same form sent again later is a new posting.
  const session = useRef(randomId());
  return useMutation<TResult, Error, TBody>({
    mutationFn: (body: TBody) => {
      const target = typeof url === "function" ? url(body) : url;
      const payload = method === "DELETE" ? undefined : body;
      const key = `${session.current}-${hash(`${method} ${target} ${JSON.stringify(payload ?? null)}`)}`;
      return api<TResult>(method, target, payload, key);
    },
    onSuccess: async (result, body) => {
      session.current = randomId();
      await invalidateAll();
      if (opts.success) toast({ title: opts.success });
      opts.onSuccess?.(result, body);
    },
    // A second tap while the first is saving: the first one's result will show.
    onError: (e, body) => {
      if (e instanceof ApiError && e.code === "IN_PROGRESS") return;
      if (opts.onError?.(e, body)) return;
      toast({ title: e.message, variant: "destructive" });
    },
  });
}
