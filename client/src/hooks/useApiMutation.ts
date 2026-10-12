import { useMutation } from "@tanstack/react-query";
import { api, invalidateAll } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

/**
 * POST/PUT/PATCH/DELETE helper: shows the server's message on error, refreshes data on success.
 */
export function useApiMutation<TBody = unknown, TResult = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string | ((body: TBody) => string),
  opts: { success?: string; onSuccess?: (result: TResult, body: TBody) => void } = {},
) {
  const { toast } = useToast();
  return useMutation<TResult, Error, TBody>({
    mutationFn: (body: TBody) => api<TResult>(method, typeof url === "function" ? url(body) : url, method === "DELETE" ? undefined : body),
    onSuccess: async (result, body) => {
      await invalidateAll();
      if (opts.success) toast({ title: opts.success });
      opts.onSuccess?.(result, body);
    },
    onError: (e) => toast({ title: e.message, variant: "destructive" }),
  });
}
