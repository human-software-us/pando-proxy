import { chunkToolResults } from "./chunking.ts";
import { createMaintenanceClients } from "./maintenance_model.ts";
import { MemoryState, SessionRecord } from "./memory_state.ts";
import { ProxyConfig } from "./config.ts";
import { retainMemory } from "./retention.ts";
import { onNewUserMessage } from "./task_update.ts";
import { extractInputs } from "./tool_results.ts";

export type MaintenanceResult = {
  record: SessionRecord;
  changed: boolean;
};

export async function runMaintenancePass(
  body: Record<string, unknown>,
  record: SessionRecord,
  config: ProxyConfig,
  authHeader: string | null,
  requestModel: string | null,
): Promise<MaintenanceResult> {
  const handled = new Set(record.handledInputIds);
  let state: MemoryState = record.memory;
  let changed = false;
  const extracted = await extractInputs(body, state);
  const clients = createMaintenanceClients(config, requestModel, authHeader);

  for (const message of extracted.userMessages) {
    if (handled.has(message.messageId)) {
      continue;
    }
    state = await onNewUserMessage(message, state, clients.taskUpdate);
    handled.add(message.messageId);
    changed = true;
  }

  const newToolResults = extracted.toolResults.filter((result) => !handled.has(result.id));
  if (newToolResults.length > 0) {
    const inbox = await chunkToolResults(newToolResults, state, clients.chunkBatch);
    state = await retainMemory(state, inbox, clients.retention);
    for (const result of newToolResults) {
      handled.add(result.id);
    }
    changed = true;
  }

  return {
    record: {
      memory: state,
      handledInputIds: [...handled],
    },
    changed,
  };
}
