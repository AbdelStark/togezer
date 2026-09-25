/**
 * Typed REST + WebSocket client for the togezer dashboard.
 *
 * All REST paths are relative so the same code works against the Vite dev
 * proxy and any same-origin production deployment. The WebSocket URL is
 * derived from the current location (ws:// or wss:// + location.host + /ws).
 */
import type {
  Agent,
  Goal,
  Lesson,
  StateSnapshot,
  Task,
  WsEvent,
} from './types';

/** Shape of the error body the API returns on non-2xx responses. */
interface ApiErrorBody {
  error?: unknown;
}

/** Shared fetch wrapper: JSON in, parsed JSON out, Error with server message on non-2xx. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `Request to ${path} failed with status ${response.status}`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (typeof body.error === 'string' && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Body was not JSON; keep the generic status-based message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** Fetch the full domain snapshot (GET /state). */
export function getState(): Promise<StateSnapshot> {
  return request<StateSnapshot>('/state');
}

/** Fetch all agents (GET /agents). */
export async function getAgents(): Promise<Agent[]> {
  const body = await request<{ agents: Agent[] }>('/agents');
  return body.agents;
}

/** Fetch the most recent lessons (GET /lessons?limit=N). */
export async function getLessons(limit = 50): Promise<Lesson[]> {
  const body = await request<{ lessons: Lesson[] }>(`/lessons?limit=${limit}`);
  return body.lessons;
}

/** Create a goal and its initial tasks (POST /goals). */
export function postGoal(text: string): Promise<{ goal: Goal; tasks: Task[] }> {
  return request<{ goal: Goal; tasks: Task[] }>('/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Handlers wired to the lifecycle of a WebSocket connection. */
export interface WsHandlers {
  /** Called for every well-formed event pushed by the server. */
  onEvent: (event: WsEvent) => void;
  /** Called whenever the connection state flips (open/close). */
  onStatusChange?: (connected: boolean) => void;
}

/** Handle to a live connection; close() stops it for good. */
export interface WsConnection {
  close(): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5000;
const JITTER_FRACTION = 0.1;

/**
 * Reconnect delay for the given consecutive-failure attempt: 500ms doubling
 * up to a 5000ms cap, plus small jitter so reconnect storms spread out.
 */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + base * JITTER_FRACTION * Math.random();
}

/** Build the same-origin WebSocket URL for the /ws endpoint. */
function wsUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location.host}/ws`;
}

/**
 * Open the server's event stream with automatic reconnect and exponential
 * backoff. Frames that fail to parse are dropped rather than crashing the
 * connection. close() marks the shutdown intentional: no further reconnects.
 */
export function connectWs(handlers: WsHandlers): WsConnection {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  let connected = false;

  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    handlers.onStatusChange?.(next);
  };

  const open = () => {
    socket = new WebSocket(wsUrl());
    socket.onopen = () => {
      attempt = 0;
      setConnected(true);
    };
    socket.onmessage = (message: MessageEvent) => {
      try {
        handlers.onEvent(JSON.parse(String(message.data)) as WsEvent);
      } catch {
        // Malformed frame: ignore it, the stream keeps flowing.
      }
    };
    socket.onclose = () => {
      setConnected(false);
      socket = null;
      if (closed) return;
      reconnectTimer = setTimeout(open, backoffDelayMs(attempt));
      attempt += 1;
    };
  };

  open();

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
