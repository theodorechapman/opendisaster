/**
 * Client-side agent logger.
 * Sends structured log entries via WebSocket to the server,
 * which appends them to agent-log.jsonl on disk.
 */

export interface LogEntry {
  ts: number;
  event: string;
  agent: string;
  data: Record<string, any>;
}

class AgentLogger {
  private ws: WebSocket | null = null;

  setWs(ws: WebSocket | null): void {
    this.ws = ws;
  }

  log(event: string, agent: string, data: Record<string, any>): void {
    const entry: LogEntry = { ts: Date.now(), event, agent, data };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "agent_log", entry }));
    }
  }
}

/** Singleton logger — import and use from any client module. */
export const agentLog = new AgentLogger();
