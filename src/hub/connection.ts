import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { Fault } from "../management/schema.js";

export type Identity =
  | { actorId: string; credential?: string }
  | { providerId: string; credential?: string };
export class HubConnection extends EventEmitter {
  readonly ws: WebSocket;
  connected = false;
  connectionId?: string;
  closeCode?: number;
  private buffered: string[] = [];
  private receiver?: (text: string) => void;
  constructor(url: string) {
    super();
    const target = new URL("/connection", url);
    target.protocol = target.protocol === "https:" || target.protocol === "wss:" ? "wss:" : "ws:";
    this.ws = new WebSocket(target, { perMessageDeflate: false });
    this.ws.on("error", () => {});
    this.ws.on("message", (raw) => {
      if (this.receiver) this.receiver(raw.toString());
      else this.buffered.push(raw.toString());
    });
    this.ws.on("close", (code) => {
      this.closeCode = code;
      this.connected = false;
      this.emit("closed", code);
    });
  }
  async admit(identity: Identity): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Fault("HUB_UNREACHABLE", "The Hub could not be reached.", 503));
      }, 10_000);
      const open = () => {
        this.listen((text) => {
          let r: any;
          try {
            r = JSON.parse(text);
          } catch {
            return;
          }
          if (r.id !== "admission") return;
          clearTimeout(timer);
          this.receiver = undefined;
          if (r.jsonrpc === "2.0" && typeof r.result?.connectionId === "string") {
            this.connected = true;
            this.connectionId = r.result.connectionId;
            resolve();
          } else {
            this.close();
            reject(new Fault("HUB_REJECTED", "The Hub refused this identity or credential.", 422));
          }
        });
        this.send({
          jsonrpc: "2.0",
          id: "admission",
          method: "connection.connect",
          params: identity,
        });
      };
      if (this.ws.readyState === WebSocket.OPEN) open();
      else this.ws.once("open", open);
      this.ws.once("error", () => {
        clearTimeout(timer);
        reject(new Fault("HUB_UNREACHABLE", "The Hub could not be reached.", 503));
      });
      this.ws.once("close", () => {
        clearTimeout(timer);
        if (!this.connectionId) reject(new Fault("HUB_REJECTED", "The Hub closed admission.", 422));
      });
    });
  }
  listen(listener: (text: string) => void): void {
    this.receiver = listener;
    const pending = this.buffered;
    this.buffered = [];
    for (const text of pending) listener(text);
  }
  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }
  close(): void {
    this.ws.close();
  }
}
