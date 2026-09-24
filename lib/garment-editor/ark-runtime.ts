export const ARK_REQUEST_TIMEOUT_MS = 60_000;

export type ArkRequestErrorCode = "ARK_TIMEOUT" | "ARK_UPSTREAM_ERROR";

export class ArkRequestError extends Error {
  readonly code: ArkRequestErrorCode;
  readonly status?: number;

  constructor(
    code: ArkRequestErrorCode,
    message: string,
    status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ArkRequestError";
    this.code = code;
    this.status = status;
  }
}

export function requireArkApiKey(
  env: Record<string, string | undefined> = process.env
) {
  const apiKey =
    env.ARK_RUNTIME_API_KEY?.trim() || env.ARK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ARK_RUNTIME_API_KEY or ARK_API_KEY is not configured");
  }
  return apiKey;
}

export async function fetchArkJson<T = unknown>(
  url: string,
  init: RequestInit = {}
): Promise<T> {
  try {
    const requestTimeoutSignal = AbortSignal.timeout(ARK_REQUEST_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, requestTimeoutSignal])
      : requestTimeoutSignal;
    const response = await fetch(url, {
      ...init,
      signal,
    });

    if (!response.ok) {
      throw new ArkRequestError(
        "ARK_UPSTREAM_ERROR",
        `Ark request failed with status ${response.status}`,
        response.status
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ArkRequestError) throw error;
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new ArkRequestError(
        "ARK_TIMEOUT",
        `Ark request exceeded ${ARK_REQUEST_TIMEOUT_MS}ms`,
        504,
        { cause: error }
      );
    }
    throw new ArkRequestError(
      "ARK_UPSTREAM_ERROR",
      "Ark request failed before receiving a complete response",
      502,
      { cause: error }
    );
  }
}

export function isArkRequestError(error: unknown): error is ArkRequestError {
  return error instanceof ArkRequestError;
}
