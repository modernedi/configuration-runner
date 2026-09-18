import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJsonValue(value[key] as JsonValue)]),
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function deterministicJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
