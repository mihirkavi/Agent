import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { tool } from "@openai/agents/realtime";
import { RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents/realtime";
import { api } from "../lib/api";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

function stringifyTaskSummary(task: {
  id: string;
  title: string;
  status: string;
  progress: Array<{ message: string }>;
  result?: { summary: string };
  missingInputs?: Array<{ label: string }>;
  approvals?: Array<{ title: string }>;
}): string {
  const latestProgress = task.progress.at(0)?.message ?? "";
  const missing = task.missingInputs?.map((item) => item.label).join(", ");
  const approvals = task.approvals?.map((item) => item.title).join(", ");

  return [
    `Task ${task.id}: ${task.title}.`,
    `Status: ${task.status}.`,
    latestProgress ? `Recent update: ${latestProgress}.` : "",
    task.result?.summary ? `Result: ${task.result.summary}.` : "",
    missing ? `Still needed: ${missing}.` : "",
    approvals ? `Pending approvals: ${approvals}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function useVoiceOperator() {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const disconnect = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setConnectionState("idle");
    setMuted(false);
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const connect = useCallback(async () => {
    if (sessionRef.current) {
      return;
    }

    setConnectionState("connecting");
    setError(null);

    try {
      const secret = await api.createRealtimeClientSecret();

      const agent = new RealtimeAgent({
        name: "Voice Operator",
        voice: "marin",
        instructions: `You are the voice layer for a persistent task operator.

Goals:
- Understand the user's request in natural language.
- Ask only for details that are genuinely required.
- When enough detail is available, call delegate_task.
- If the backend later reports missing details, ask the user and call provide_task_inputs.
- If the backend reports a pending approval, ask the user for a yes/no answer and call resolve_task_approval.
- Never claim a task is completed unless the backend status says completed.
- Keep spoken answers brief and operational.`,
        tools: [
          tool({
            name: "delegate_task",
            description:
              "Create a new background task once the user's request is specific enough to execute.",
            parameters: z.object({
              request: z.string(),
              title: z.string().optional()
            }),
            execute: async ({ request, title }) => {
              const task = await api.submitTask({ request, title });
              return stringifyTaskSummary(task);
            }
          }),
          tool({
            name: "get_task_status",
            description:
              "Fetch the latest status for a task. If taskId is omitted, return the most recent task.",
            parameters: z.object({
              taskId: z.string().optional()
            }),
            execute: async ({ taskId }) => {
              const task = taskId
                ? await api.getTask(taskId)
                : (await api.listTasks())[0];

              if (!task) {
                return "There are no tasks yet.";
              }

              return stringifyTaskSummary(task);
            }
          }),
          tool({
            name: "provide_task_inputs",
            description:
              "Submit one or more missing task details after the user answers a clarification question.",
            parameters: z.object({
              taskId: z.string(),
              inputs: z.record(z.string(), z.string())
            }),
            execute: async ({ taskId, inputs }) => {
              const task = await api.updateTaskInputs(taskId, { inputs });
              return stringifyTaskSummary(task);
            }
          }),
          tool({
            name: "resolve_task_approval",
            description:
              "Approve or reject a pending approval request after the user explicitly says yes or no.",
            parameters: z.object({
              taskId: z.string(),
              approvalId: z.string(),
              approved: z.boolean()
            }),
            execute: async ({ taskId, approvalId, approved }) => {
              const task = await api.resolveApproval(taskId, {
                approvalId,
                approved
              });
              return stringifyTaskSummary(task);
            }
          })
        ]
      });

      const session = new RealtimeSession(agent, {
        transport: "webrtc"
      });

      session.on("history_updated", (nextHistory) => {
        setHistory(nextHistory);
      });

      session.on("error", (event) => {
        setError(
          event.error instanceof Error
            ? event.error.message
            : "Realtime session error."
        );
        setConnectionState("error");
      });

      session.on("audio_interrupted", () => {
        setMuted(false);
      });

      await session.connect({
        apiKey: secret.value
      });

      sessionRef.current = session;
      setConnectionState("connected");
    } catch (connectError) {
      setConnectionState("error");
      setError(
        connectError instanceof Error
          ? connectError.message
          : "Unable to connect to the voice session."
      );
    }
  }, []);

  const sendTextMessage = useCallback((message: string) => {
    if (!sessionRef.current || !message.trim()) {
      return;
    }

    sessionRef.current.sendMessage(message.trim());
  }, []);

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
  }, []);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }

    const nextMuted = !session.muted;
    session.mute(nextMuted);
    setMuted(nextMuted);
  }, []);

  return {
    connectionState,
    history,
    error,
    muted,
    connect,
    disconnect,
    interrupt,
    sendTextMessage,
    toggleMute
  };
}
