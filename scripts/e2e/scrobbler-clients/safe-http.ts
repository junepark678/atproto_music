/** Fetch wrapper that never forwards transport error text or follows redirects. */
export async function fetchWithoutLeak(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await fetchImpl(input, { ...init, redirect: 'error' });
  } catch {
    throw new Error(`${operation} transport failed`);
  }
}

/** JSON parser with a fixed error message so a server body cannot enter an exception. */
export async function jsonWithoutLeak(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}
