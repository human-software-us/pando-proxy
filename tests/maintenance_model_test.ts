import {
  chunkBatchSystemPrompt,
  DEFAULT_LARGE_MAINTENANCE_MODEL,
  DEFAULT_SMALL_MAINTENANCE_MODEL,
  MAINTENANCE_MODEL_CONTEXT_WINDOWS,
  normalizeMaintenanceModel,
  selectMaintenanceModel,
} from "../src/maintenance_model.ts";

Deno.test("maintenance model selector uses configured small override", () => {
  assertEquals(
    selectMaintenanceModel({
      configuredModel: "small",
      requestModel: "gpt-5.4",
      system: "system",
      payloadText: "payload",
      schema: {},
    }),
    DEFAULT_SMALL_MAINTENANCE_MODEL,
  );
});

Deno.test("maintenance model selector uses configured large override", () => {
  assertEquals(
    selectMaintenanceModel({
      configuredModel: "large",
      requestModel: "gpt-5.4",
      system: "system",
      payloadText: "payload",
      schema: {},
    }),
    DEFAULT_LARGE_MAINTENANCE_MODEL,
  );
});

Deno.test("maintenance model selector defaults to small model", () => {
  assertEquals(
    selectMaintenanceModel({
      configuredModel: null,
      requestModel: "gpt-5.4",
      system: "system",
      payloadText: "payload",
      schema: {},
    }),
    DEFAULT_SMALL_MAINTENANCE_MODEL,
  );
});

Deno.test("maintenance model selector switches to large model when context is too large", () => {
  const smallWindow = MAINTENANCE_MODEL_CONTEXT_WINDOWS[DEFAULT_SMALL_MAINTENANCE_MODEL];
  assertEquals(
    selectMaintenanceModel({
      configuredModel: null,
      requestModel: "gpt-5.4",
      system: "system",
      payloadText: "x".repeat(smallWindow * 4),
      schema: {},
    }),
    DEFAULT_LARGE_MAINTENANCE_MODEL,
  );
});

Deno.test("maintenance model selector rejects unsupported overrides", () => {
  assertThrows(() => normalizeMaintenanceModel("custom-maintenance-model"));
});

Deno.test("chunk batch prompt asks for semantic retention-sized chunks", () => {
  assert(chunkBatchSystemPrompt.includes("task-scoped context memory"));
  assert(chunkBatchSystemPrompt.includes("Split arrays, search results, lists"));
  assert(chunkBatchSystemPrompt.includes("more small chunks than one broad chunk"));
  assert(chunkBatchSystemPrompt.includes("keptUserMessages"));
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(callback: () => unknown): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("Expected callback to throw");
}

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
