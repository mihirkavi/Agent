import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { tool } from "@openai/agents/realtime";
import { RealtimeAgent, RealtimeSession, type RealtimeItem } from "@openai/agents/realtime";
import { api } from "../lib/api";

type ConnectionState = "idle" | "connecting" | "connected" | "error";

declare global {
  interface Window {
    __voiceOperatorDebug?: {
      sendTextMessage: (message: string) => void;
      getConnectionState: () => ConnectionState;
      reconnect: () => void;
    };
  }
}

function stringifyTaskSummary(task: {
  id: string;
  title: string;
  status: string;
  progress: Array<{ message: string }>;
  result?: { summary: string; details: string; nextSteps?: string[] };
  missingInputs?: Array<{ id: string; label: string }>;
  approvals?: Array<{ id: string; title: string }>;
}): string {
  const latestProgress = task.progress.at(-1)?.message ?? "";
  const missing = task.missingInputs
    ?.map((item) => `${item.id}: ${item.label}`)
    .join("; ");
  const approvals = task.approvals
    ?.map((item) => `${item.id}: ${item.title}`)
    .join("; ");

  return [
    `Task ${task.id}: ${task.title}.`,
    `Status: ${task.status}.`,
    latestProgress ? `Recent update: ${latestProgress}.` : "",
    task.result?.summary ? `Result: ${task.result.summary}.` : "",
    task.result?.details ? `Result details: ${task.result.details}.` : "",
    task.result?.nextSteps?.length
      ? `Next steps: ${task.result.nextSteps.join(" ")}`
      : "",
    missing ? `Required user inputs by id: ${missing}.` : "",
    approvals ? `Pending approvals by id: ${approvals}.` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function useVoiceOperator() {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const attemptedAutoconnectRef = useRef(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [history, setHistory] = useState<RealtimeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const wait = useCallback(async (milliseconds: number) => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }, []);

  const waitForTaskTurn = useCallback(
    async (taskId: string) => {
      let task = await api.getTask(taskId);
      const startedAt = Date.now();

      while (Date.now() - startedAt < 15000) {
        if (
          task.status === "needs_input" ||
          task.status === "needs_approval" ||
          task.status === "completed" ||
          task.status === "failed" ||
          task.status === "cancelled" ||
          task.missingInputs.length > 0 ||
          task.approvals.length > 0 ||
          Boolean(task.result) ||
          task.selectedExecutor !== "router"
        ) {
          return task;
        }

        await wait(900);
        task = await api.getTask(taskId);
      }

      return task;
    },
    [wait]
  );

  const requestMicrophoneAccess = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone access.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });
    stream.getTracks().forEach((track) => track.stop());
  }, []);

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
      await requestMicrophoneAccess();
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
- Never claim an external account or website was changed unless the backend result details explicitly say the account write already happened.
- If a calendar task result says an import file or deeplink was created, say exactly that. Do not say it already appeared in the user's personal calendar.
- Default to English unless the user explicitly speaks another language.
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
              const updatedTask = await waitForTaskTurn(task.id);
              return stringifyTaskSummary(updatedTask);
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
              const updatedTask = await waitForTaskTurn(task.id);
              return stringifyTaskSummary(updatedTask);
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
              const updatedTask = await waitForTaskTurn(task.id);
              return stringifyTaskSummary(updatedTask);
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
        sessionRef.current = null;
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
  }, [requestMicrophoneAccess, waitForTaskTurn]);

  useEffect(() => {
    if (attemptedAutoconnectRef.current) {
      return;
    }

    attemptedAutoconnectRef.current = true;
    void connect();
  }, [connect]);

  useEffect(() => {
    if (connectionState !== "error" || sessionRef.current) {
      return;
    }

    if (error?.toLowerCase().includes("permission")) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void connect();
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [connectionState, connect, error]);

  const sendTextMessage = useCallback((message: string) => {
    if (!sessionRef.current || !message.trim()) {
      return;
    }

    sessionRef.current.sendMessage(message.trim());
  }, []);

  useEffect(() => {
    window.__voiceOperatorDebug = {
      sendTextMessage,
      getConnectionState: () => connectionState,
      reconnect: () => {
        void connect();
      }
    };

    return () => {
      delete window.__voiceOperatorDebug;
    };
  }, [connect, connectionState, sendTextMessage]);

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
    disconnect,
    interrupt,
    toggleMute
  };
}
