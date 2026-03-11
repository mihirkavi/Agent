import type {
  ClientSecretResponse,
  ResolveApprovalPayload,
  SubmitTaskPayload,
  TaskRecord,
  UpdateTaskInputsPayload
} from "../../shared/types";

export interface HealthResponse {
  ok: boolean;
  openAiConfigured: boolean;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  getHealth(): Promise<HealthResponse> {
    return requestJson<HealthResponse>("/api/health");
  },
  listTasks(): Promise<TaskRecord[]> {
    return requestJson<TaskRecord[]>("/api/tasks");
  },
  submitTask(payload: SubmitTaskPayload): Promise<TaskRecord> {
    return requestJson<TaskRecord>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  updateTaskInputs(
    taskId: string,
    payload: UpdateTaskInputsPayload
  ): Promise<TaskRecord> {
    return requestJson<TaskRecord>(`/api/tasks/${taskId}/input`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  resolveApproval(
    taskId: string,
    payload: ResolveApprovalPayload
  ): Promise<TaskRecord> {
    return requestJson<TaskRecord>(`/api/tasks/${taskId}/approve`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  },
  createRealtimeClientSecret(): Promise<ClientSecretResponse> {
    return requestJson<ClientSecretResponse>("/api/realtime/client-secret", {
      method: "POST"
    });
  },
  getTask(taskId: string): Promise<TaskRecord> {
    return requestJson<TaskRecord>(`/api/tasks/${taskId}`);
  }
};
