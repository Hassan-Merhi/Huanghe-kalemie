import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api";

export type Role = "owner" | "manager" | "cashier" | "partner";

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  partnerId: number | null;
  language: "fr" | "en";
}

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Owner can do everything; the others only what is listed. */
  can: (...roles: Role[]) => boolean;
  refresh: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const q = useQuery<User | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      try {
        return await api<User | null>("GET", "/api/auth/me?optional=1");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
  const user = q.data ?? null;
  const can = (...roles: Role[]) => !!user && (user.role === "owner" || roles.includes(user.role));
  return <Ctx.Provider value={{ user, loading: q.isLoading, can, refresh: () => q.refetch() }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
