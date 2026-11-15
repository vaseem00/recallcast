/**
 * Test helper: an in-memory stand-in for the `cookies()` store from next/headers.
 * Used with vi.mock("next/headers", ...) in auth tests. Not imported by app code.
 */

export interface SetCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

export class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly sets: SetCall[] = [];
  /** Simulates a Server Component render, where writing cookies throws. */
  readOnly = false;

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  set(name: string, value: string, options: Record<string, unknown> = {}): void {
    if (this.readOnly) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
    this.sets.push({ name, value, options });
    if (options.maxAge === 0 || value === "") this.jar.delete(name);
    else this.jar.set(name, value);
  }

  delete(name: string): void {
    this.set(name, "", { maxAge: 0 });
  }

  reset(): void {
    this.jar.clear();
    this.sets.length = 0;
    this.readOnly = false;
  }

  lastSet(name: string): SetCall | undefined {
    return [...this.sets].reverse().find((s) => s.name === name);
  }
}
