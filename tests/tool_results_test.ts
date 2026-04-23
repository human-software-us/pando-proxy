import { emptyMemoryState } from "../src/memory_state.ts";
import { extractInputs, isPandoResult } from "../src/tool_results.ts";

Deno.test("extractInputs ignores synthetic memory and maps tool output to preceding call", async () => {
  const extracted = await extractInputs({
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<context_memory>\nold\n</context_memory>" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Implement this" }],
      },
      {
        type: "function_call",
        id: "call_1",
        call_id: "call_1",
        name: "pando__find_nodes",
        arguments: '{"name":"main"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"nodes":[{"name":"main","path":"src/main.ts"}]}',
      },
    ],
  }, emptyMemoryState());

  assertEquals(extracted.userMessages.length, 1);
  assertEquals(extracted.assistantResponses.length, 0);
  assertEquals(extracted.userMessages[0].text, "Implement this");
  assertEquals(extracted.toolResults.length, 1);
  assertEquals(extracted.toolResults[0].toolName, "pando__find_nodes");
  assertEquals(extracted.toolResults[0].params, { name: "main" });
});

Deno.test("extractInputs ignores environment context user messages", async () => {
  const extracted = await extractInputs({
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text:
            "<environment_context>\n  <cwd>/repo</cwd>\n  <shell>zsh</shell>\n</environment_context>",
        }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Do the actual task." }],
      },
    ],
  }, emptyMemoryState());

  assertEquals(extracted.userMessages.length, 1);
  assertEquals(extracted.userMessages[0].text, "Do the actual task.");
});

Deno.test("extractInputs captures assistant response text for next-turn review", async () => {
  const extracted = await extractInputs({
    input: [
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "The implementation passed live testing." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue" }],
      },
    ],
  }, emptyMemoryState());

  assertEquals(extracted.assistantResponses.length, 1);
  assertEquals(extracted.assistantResponses[0].responseId, "assistant_msg_1");
  assertEquals(extracted.assistantResponses[0].text, "The implementation passed live testing.");
});

Deno.test("isPandoResult detects qualified pando tool names", () => {
  assert(isPandoResult({ toolName: "pando__find_nodes", content: null }));
  assert(isPandoResult({ toolName: "myserver__find_references", content: null }));
});

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
