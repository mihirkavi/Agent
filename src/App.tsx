import { startTransition, useEffect, useState } from "react";
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
  const [request, setRequest] = useState("");
  const [chatMessage, setChatMessage] = useState("");
  const [taskDrafts, setTaskDrafts] = useState<Record<string, Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
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

  const activeTask =
    tasks.find((task) => ["running", "queued", "needs_input", "needs_approval"].includes(task.status)) ??
    tasks[0];

  const transcript = voice.history
    .map(renderRealtimeItem)
    .filter((item) => item.body.trim());

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request.trim()) {
      return;
    }

    setSubmitting(true);
    setTaskError(null);
    try {
      const created = await api.submitTask({
        request: request.trim()
      });
      setRequest("");
      setTasks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    } catch (error) {
      setTaskError(
        error instanceof Error ? error.message : "Unable to submit task."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submitTaskInputs(task: TaskRecord) {
    const draft = taskDrafts[task.id] ?? {};
    const inputs = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value.trim())
    );

    if (Object.keys(inputs).length === 0) {
      return;
    }

    const updated = await api.updateTaskInputs(task.id, { inputs });
    setTaskDrafts((current) => {
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setTasks((current) =>
      current.map((item) => (item.id === updated.id ? updated : item))
    );
  }

  async function resolveApproval(taskId: string, approvalId: string, approved: boolean) {
    const updated = await api.resolveApproval(taskId, { approvalId, approved });
    setTasks((current) =>
      current.map((item) => (item.id === updated.id ? updated : item))
    );
  }

  async function sendTextMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatMessage.trim()) {
      return;
    }
    voice.sendTextMessage(chatMessage);
    setChatMessage("");
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Voice-first task operator</p>
          <h1>Speak once. The agent keeps going until the workflow lands.</h1>
          <p className="hero-copy">
            This app pairs a live `gpt-realtime` voice session with a background task
            worker that can research, navigate websites, pause for approvals, and keep
            the run moving without constant hand-holding.
          </p>
        </div>
        <div className="hero-status">
          <div className="status-chip">
            <span className="status-dot" data-state={voice.connectionState} />
            Voice {voice.connectionState}
          </div>
          <div className="status-chip">
            OpenAI {health?.openAiConfigured ? "configured" : "missing key"}
          </div>
        </div>
      </section>

      <section className="layout-grid">
        <section className="panel spotlight">
          <header className="panel-header">
            <div>
              <p className="panel-kicker">Live Console</p>
              <h2>Voice cockpit</h2>
            </div>
            <div className="button-row">
              <button
                className="button accent"
                onClick={voice.connectionState === "connected" ? voice.disconnect : voice.connect}
                type="button"
              >
                {voice.connectionState === "connected" ? "Disconnect" : "Connect voice"}
              </button>
              <button
                className="button"
                disabled={voice.connectionState !== "connected"}
                onClick={voice.toggleMute}
                type="button"
              >
                {voice.muted ? "Unmute mic" : "Mute mic"}
              </button>
              <button
                className="button"
                disabled={voice.connectionState !== "connected"}
                onClick={voice.interrupt}
                type="button"
              >
                Interrupt
              </button>
            </div>
          </header>

          <form className="composer" onSubmit={sendTextMessage}>
            <label className="field">
              <span>Text fallback to the live agent</span>
              <textarea
                onChange={(event) => setChatMessage(event.target.value)}
                placeholder="Tell the live voice agent what to do or answer its question."
                rows={3}
                value={chatMessage}
              />
            </label>
            <button className="button accent" type="submit">
              Send to voice session
            </button>
          </form>

          {voice.error ? <p className="inline-error">{voice.error}</p> : null}

          <div className="transcript">
            {transcript.length === 0 ? (
              <p className="empty-state">
                No live transcript yet. Connect voice to start a realtime session.
              </p>
            ) : (
              transcript.slice(-10).map((entry, index) => (
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
              <p className="panel-kicker">Manual kickoff</p>
              <h2>Submit a task directly</h2>
            </div>
          </header>

          <form className="composer" onSubmit={submitRequest}>
            <label className="field">
              <span>Task request</span>
              <textarea
                onChange={(event) => setRequest(event.target.value)}
                placeholder="Book a haircut for Friday afternoon near San Francisco, prefer any stylist under $70."
                rows={5}
                value={request}
              />
            </label>
            <button className="button accent" disabled={submitting} type="submit">
              {submitting ? "Submitting..." : "Create task"}
            </button>
          </form>

          {taskError ? <p className="inline-error">{taskError}</p> : null}

          <div className="health-note">
            <strong>Execution policy:</strong> the app minimizes clarification, but it
            still pauses for sensitive actions like authentication, payment, destructive
            changes, and unknown automation domains.
          </div>
        </section>

        <section className="panel wide">
          <header className="panel-header">
            <div>
              <p className="panel-kicker">Task board</p>
              <h2>Background runs</h2>
            </div>
            <p className="panel-meta">{tasks.length} task(s)</p>
          </header>

          {tasks.length === 0 ? (
            <p className="empty-state">
              No tasks yet. Speak a request or submit one manually.
            </p>
          ) : (
            <div className="task-list">
              {tasks.map((task) => (
                <article className="task-card" key={task.id}>
                  <header className="task-header">
                    <div>
                      <p className="task-status" data-status={task.status}>
                        {task.status.replaceAll("_", " ")}
                      </p>
                      <h3>{task.title}</h3>
                    </div>
                    <p className="task-time">{formatTimestamp(task.updatedAt)}</p>
                  </header>

                  <p className="task-request">{task.userRequest}</p>

                  <div className="task-meta-grid">
                    <div>
                      <span>Executor</span>
                      <strong>{task.selectedExecutor}</strong>
                    </div>
                    <div>
                      <span>Category</span>
                      <strong>{task.category}</strong>
                    </div>
                    <div>
                      <span>Domains</span>
                      <strong>{task.suggestedDomains.join(", ") || "none yet"}</strong>
                    </div>
                  </div>

                  {task.execution.plan ? (
                    <p className="plan-box">{task.execution.plan}</p>
                  ) : null}

                  {task.missingInputs.length > 0 ? (
                    <section className="action-box">
                      <h4>More information needed</h4>
                      {task.missingInputs.map((question) => (
                        <label className="field" key={question.id}>
                          <span>{question.label}</span>
                          <input
                            onChange={(event) =>
                              setTaskDrafts((current) => ({
                                ...current,
                                [task.id]: {
                                  ...(current[task.id] ?? {}),
                                  [question.id]: event.target.value
                                }
                              }))
                            }
                            placeholder={question.placeholder ?? question.description}
                            type={question.sensitive ? "password" : "text"}
                            value={taskDrafts[task.id]?.[question.id] ?? ""}
                          />
                        </label>
                      ))}
                      <button
                        className="button accent"
                        onClick={() => {
                          void submitTaskInputs(task);
                        }}
                        type="button"
                      >
                        Submit details
                      </button>
                    </section>
                  ) : null}

                  {task.approvals.length > 0 ? (
                    <section className="action-box">
                      <h4>Pending approvals</h4>
                      {task.approvals.map((approval) => (
                        <div className="approval-row" key={approval.id}>
                          <div>
                            <strong>{approval.title}</strong>
                            <p>{approval.reason}</p>
                          </div>
                          <div className="button-row">
                            <button
                              className="button accent"
                              onClick={() => {
                                void resolveApproval(task.id, approval.id, true);
                              }}
                              type="button"
                            >
                              Approve
                            </button>
                            <button
                              className="button"
                              onClick={() => {
                                void resolveApproval(task.id, approval.id, false);
                              }}
                              type="button"
                            >
                              Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </section>
                  ) : null}

                  {task.result ? (
                    <section className="result-box">
                      <h4>{task.result.summary}</h4>
                      <p>{task.result.details}</p>
                      {task.result.sources.length > 0 ? (
                        <div className="link-list">
                          {task.result.sources.map((source) => (
                            <a href={source} key={source} rel="noreferrer" target="_blank">
                              {source}
                            </a>
                          ))}
                        </div>
                      ) : null}
                      {task.result.artifactUrls.length > 0 ? (
                        <div className="link-list">
                          {task.result.artifactUrls.map((artifactUrl) => (
                            <a href={artifactUrl} key={artifactUrl} rel="noreferrer" target="_blank">
                              Open artifact
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {task.error ? <p className="inline-error">{task.error}</p> : null}

                  <div className="progress-log">
                    {task.progress.slice(0, 5).map((entry) => (
                      <div className="progress-row" key={entry.id}>
                        <span>{entry.message}</span>
                        <time>{formatTimestamp(entry.createdAt)}</time>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <header className="panel-header">
            <div>
              <p className="panel-kicker">Current focus</p>
              <h2>Operator snapshot</h2>
            </div>
          </header>

          {activeTask ? (
            <>
              <p className="task-status" data-status={activeTask.status}>
                {activeTask.status.replaceAll("_", " ")}
              </p>
              <h3>{activeTask.title}</h3>
              <p className="task-request">{activeTask.userRequest}</p>
              <div className="progress-log">
                {activeTask.progress.slice(0, 8).map((entry) => (
                  <div className="progress-row" key={entry.id}>
                    <span>{entry.message}</span>
                    <time>{formatTimestamp(entry.createdAt)}</time>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="empty-state">No active task.</p>
          )}
        </section>
      </section>
    </main>
  );
}
