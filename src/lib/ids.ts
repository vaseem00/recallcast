import { randomUUID } from "node:crypto";

/** New text UUID (v4) for primary keys. */
export function newId(): string {
  return randomUUID();
}
