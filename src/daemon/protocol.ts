export const DEFAULT_DAEMON_HOST = "127.0.0.1";
export const DEFAULT_DAEMON_PORT = 43111;

export interface DaemonHealthResponse {
  ok: boolean;
  service: string;
  timestamp: string;
}

export interface DaemonErrorResponse {
  ok: false;
  error: string;
}
