import { startTransition, useEffect, useMemo, useState } from "react";
import type { RealtimeItem } from "@openai/agents/realtime";
import type { TaskRecord } from "../shared/types";
import { useVoiceOperator } from "./hooks/useVoiceOperator";
import { api, type HealthResponse } from "./lib/api";

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function renderRealtimeItem(item: RealtimeItem): { label: string; body: string } {
  if (item.type === "message") {
    const body = item.content
      .map((part) => {
        if (part.type === "input_text" || part.type === "output_text") {
          return part.text;
        }
        return part.transcript ?? "";
      })
      .filter(Boolean)
      .join(" ");

    return {
      label: item.role,
      body
    };
  }

  if (item.type === "function_call") {
    return {
      label: "tool",
      body: `${item.name}(${item.arguments})`
    };
  }

  if (item.type === "mcp_approval_request") {
    return {
      label: "approval",
      body: `${item.serverLabel}: ${item.name}`
    };
  }

  return {
    label: item.type,
    body: item.output ?? item.arguments
  };
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskError, setTaskError] = useState<string | null>(null);
  const voice = useVoiceOperator();

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [healthResponse, taskResponse] = await Promise.all([
          api.getHealth(),
          api.listTasks()
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setHealth(healthResponse);
          setTasks(taskResponse);
        });
      } catch (error) {
        if (!cancelled) {
          setTaskError(
            error instanceof Error ? error.message : "Unable to load app state."
          );
        }
      }
    };

    void load();
    const intervalId = window.setInterval(() => {
      void api
        .listTasks()
        .then((nextTasks) => {
          if (!cancelled) {
            startTransition(() => {
              setTasks(nextTasks);
            });
          }
        })
        .catch(() => undefined);
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeTask = tasks[0];

  const transcript = voice.history
    .map(renderRealtimeItem)
    .filter((item) => item.body.trim());
  const statusCopy = useMemo(() => {
    if (voice.connectionState === "connecting") {
      return "Connecting to the live voice session. Allow microphone access if the browser asks.";
    }

    if (voice.connectionState === "connected") {
      return "Listening. Say what you want done, then answer follow-up questions out loud.";
    }

    if (voice.connectionState === "error") {
      return "Voice setup failed. Check microphone permissions and refresh the page.";
    }

    return "Starting voice operator.";
  }, [voice.connectionState]);

  return (
    <main className="voice-page">
      <section className="voice-stage">
        <p className="eyebrow">Voice Operator</p>
        <h1>Just speak.</h1>
        <p className="hero-copy">
          No buttons. No text forms. The session starts automatically, listens for
          your request, and keeps the task moving by voice.
        </p>

        <div className={`voice-orb voice-orb--${voice.connectionState}`}>
          <div className="voice-orb-core" />
        </div>

        <div className="status-stack">
          <p className="status-line">
            <span className="status-dot" data-state={voice.connectionState} />
            Voice {voice.connectionState}
          </p>
          <p className="status-copy">{statusCopy}</p>
          <p className="status-copy">
            OpenAI {health?.openAiConfigured ? "configured" : "missing key"}
          </p>
          {voice.error ? <p className="inline-error">{voice.error}</p> : null}
          {taskError ? <p className="inline-error">{taskError}</p> : null}
        </div>
      </section>

      <section className="voice-grid">
        <section className="panel">
          <header className="panel-header">
            <div>
              <p className="panel-kicker">Conversation</p>
              <h2>Live transcript</h2>
            </div>
          </header>

          <div className="transcript">
            {transcript.length === 0 ? (
              <p className="empty-state">
                Waiting for the first turn. If a browser microphone prompt appears,
                allow it and then speak your request.
              </p>
            ) : (
              transcript.slice(-12).map((entry, index) => (
                <article className="transcript-row" key={`${entry.label}-${index}`}>
                  <p className="transcript-label">{entry.label}</p>
                  <p>{entry.body}</p>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <p className="panel-kicker">Current task</p>
              <h2>Operator state</h2>
            </div>
          </header>

          {activeTask ? (
            <article className="task-card">
              <p className="task-status" data-status={activeTask.status}>
                {activeTask.status.replaceAll("_", " ")}
              </p>
              <h3>{activeTask.title}</h3>
              <p className="task-request">{activeTask.userRequest}</p>
              {activeTask.execution.plan ? (
                <p className="plan-box">{activeTask.execution.plan}</p>
              ) : null}
              {activeTask.missingInputs.length > 0 ? (
                <div className="note-block">
                  The agent is waiting for spoken answers about{" "}
                  {activeTask.missingInputs.map((question) => question.label).join(", ")}.
                </div>
              ) : null}
              {activeTask.approvals.length > 0 ? (
                <div className="note-block">
                  The agent is waiting for a spoken yes or no on{" "}
                  {activeTask.approvals.map((approval) => approval.title).join(", ")}.
                </div>
              ) : null}
              {activeTask.result ? (
                <div className="result-box">
                  <h4>{activeTask.result.summary}</h4>
                  <p>{activeTask.result.details}</p>
                </div>
              ) : null}
              {activeTask.error ? <p className="inline-error">{activeTask.error}</p> : null}
              <div className="progress-log">
                {activeTask.progress.slice(-6).reverse().map((entry) => (
                  <div className="progress-row" key={entry.id}>
                    <span>{entry.message}</span>
                    <time>{formatTimestamp(entry.createdAt)}</time>
                  </div>
                ))}
              </div>
            </article>
          ) : (
            <p className="empty-state">
              Ready for a voice request. The first task will appear here automatically.
            </p>
          )}
        </section>
      </section>
    </main>
  );
}
