import type { CommandMap, CommandName, CommandResultMap, IpcEvent, IpcResult } from "@ltw/domain";

export interface Api {
  invoke<C extends CommandName>(command: C, ...payload: CommandMap[C] extends undefined ? [] : [CommandMap[C]]): Promise<IpcResult<CommandResultMap[C]>>;
  onEvent(callback: (event: IpcEvent) => void): () => void;
}

type AnyResult = IpcResult<unknown>;

interface ElectronBridge {
  invoke(command: string, payload?: unknown): Promise<AnyResult>;
  onEvent(callback: (event: IpcEvent) => void): () => void;
}
declare global {
  interface Window {
    /** Present only inside the desktop app (added by its preload script). */
    ltw?: ElectronBridge;
  }
}

let counter = 0;

/** Browser dev mode: the same commands, sent to the dev bridge over HTTP. */
const webBridge: ElectronBridge = {
  async invoke(command, payload) {
    const requestId = `w${++counter}`;
    try {
      const res = await fetch("/ipc", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ltw-dev": "1" },
        body: JSON.stringify({ requestId, command, payload }),
      });
      return (await res.json()) as AnyResult;
    } catch {
      return { requestId, ok: false, error: { code: "connection", message: "Could not reach the app's background process." } };
    }
  },
  onEvent(callback) {
    const source = new EventSource("/events");
    source.onmessage = (m) => {
      try {
        callback(JSON.parse(m.data) as IpcEvent);
      } catch {
        /* ignore malformed pings */
      }
    };
    return () => source.close();
  },
};

const bridge: ElectronBridge = window.ltw ?? webBridge;

export const api: Api = {
  invoke: ((command: string, payload?: unknown) => bridge.invoke(command, payload)) as Api["invoke"],
  onEvent: (cb) => bridge.onEvent(cb),
};
