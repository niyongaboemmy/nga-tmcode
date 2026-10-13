/**
 * The two ways to reach Task Mentor's code runner: signed in (the desktop's account host, with the
 * TMCode user token, `/api/tmcode/code/*`) and in an exam (the exam's token, `/sessions/:sid/code/*`).
 */
import type { ApiError, TmApi } from "../exam/api";
import type { AccountHost } from "../platform/types";
import { CodeRunnerError, type CodeTransport } from "./codeRunner";

export function accountCodeTransport(host: AccountHost): CodeTransport {
  return {
    where: "account",
    async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
      let res;
      try {
        res = await host.request<Record<string, unknown> | null>({ method, path: `/api/tmcode/code${path}`, ...(body !== undefined ? { json: body } : {}) });
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        throw new CodeRunnerError(0, /sign in/i.test(message) ? "SIGNED_OUT" : "OFFLINE", message);
      }
      if (res.status >= 200 && res.status < 300) return res.body as T;
      const b = (res.body ?? {}) as Record<string, unknown>;
      throw new CodeRunnerError(res.status, String(b.code ?? b.error_code ?? `HTTP_${res.status}`), typeof b.message === "string" ? b.message : `Task Mentor answered ${res.status}.`, b);
    },
    stream(path, on) {
      if (!host.stream) return null;
      let cancelled = false;
      let handle: { cancel(): void } | null = null;
      host
        .stream(`/api/tmcode/code${path}`, (e) => {
          if (cancelled) return;
          if (e.type === "status") on.status?.(e.status);
          else if (e.type === "data") on.data(e.data);
          else if (e.type === "end") on.end();
          else on.end(e.message);
        })
        .then((h) => (cancelled ? h.cancel() : (handle = h)))
        .catch((e) => on.end(String((e as Error)?.message ?? e)));
      return {
        cancel() {
          cancelled = true;
          handle?.cancel();
        },
      };
    },
  };
}

export function examCodeTransport(api: TmApi): CodeTransport {
  return {
    where: "exam",
    async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
      try {
        return await api.code<T>(method, path, body);
      } catch (e) {
        const err = e as ApiError;
        throw new CodeRunnerError(err.status ?? 0, err.code ?? "OFFLINE", err.message, err.data ?? {});
      }
    },
    stream: (path, on) => api.codeStream(path, on),
  };
}
