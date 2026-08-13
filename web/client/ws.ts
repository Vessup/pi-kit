import { buildSocketUrl, getSocketCandidates, isServerMessage, parseSocketMessage } from "./api";

type Listener<T> = (value: T) => void;

export class SessionSocket {
  private socket: WebSocket | null = null;
  private readonly messageListeners = new Set<Listener<unknown>>();
  private readonly closeListeners = new Set<Listener<CloseEvent>>();
  private readonly openListeners = new Set<Listener<Event>>();
  private closed = false;
  private attempts = 0;
  private readonly candidates = getSocketCandidates();

  onMessage(listener: Listener<unknown>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: Listener<CloseEvent>): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onOpen(listener: Listener<Event>): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.attempts = 0;
    return new Promise((resolve, reject) => {
      const tryNext = () => {
        if (this.closed) {
          reject(new Error("Socket closed"));
          return;
        }
        const path = this.candidates[this.attempts++];
        if (!path) {
          reject(new Error("Unable to connect to session socket"));
          return;
        }
        const socket = new WebSocket(buildSocketUrl(path));
        this.socket = socket;
        let connected = false;
        let advanced = false;
        const advanceOnce = () => {
          if (advanced || connected || this.closed) return;
          advanced = true;
          tryNext();
        };
        socket.addEventListener("open", (event) => {
          connected = true;
          for (const listener of this.openListeners) listener(event);
          socket.send(JSON.stringify({ type: "client.hello" }));
          resolve();
        }, { once: true });
        socket.addEventListener("message", (event) => {
          const message = parseSocketMessage(String(event.data));
          if (isServerMessage(message) || typeof message !== "undefined") {
            for (const listener of this.messageListeners) listener(message);
          }
        });
        socket.addEventListener("close", (event) => {
          for (const listener of this.closeListeners) listener(event);
          advanceOnce();
        }, { once: true });
        socket.addEventListener("error", () => {
          advanceOnce();
        }, { once: true });
      };
      tryNext();
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Session socket is not open");
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
