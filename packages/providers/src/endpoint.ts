/**
 * Rules for which server addresses the app may talk to (spec 01, "Local-first boundaries").
 * The same machine is always fine; anything else needs the user to say so, naming the host.
 */

export type ParsedEndpoint =
  | { ok: true; baseUrl: string; host: string; hostname: string; loopback: boolean }
  | { ok: false; message: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseEndpoint(raw: string): ParsedEndpoint {
  const text = raw.trim();
  if (text === "") return { ok: false, message: "Enter the server address, for example http://localhost:1234/v1." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `"${text}" is not a valid address. It should look like http://localhost:1234/v1.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Only http:// and https:// addresses are allowed." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "Do not put a username or password in the address. Use the API key field instead." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, message: "The address must not contain ? or #." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return {
    ok: true,
    baseUrl: `${url.protocol}//${url.host}${path}`,
    host: url.host,
    hostname: url.hostname,
    loopback: LOOPBACK.has(url.hostname),
  };
}

/** `allowedRemoteHosts` holds `host:port` strings (as in `ParsedEndpoint.host`) the user explicitly approved. */
export function checkEndpointAllowed(raw: string, allowedRemoteHosts: ReadonlySet<string>): ParsedEndpoint {
  const p = parseEndpoint(raw);
  if (!p.ok) return p;
  if (p.loopback || allowedRemoteHosts.has(p.host)) return p;
  return {
    ok: false,
    message: `${p.host} is not on this computer. Text you translate would be sent over the network to it. Allow that explicitly in the connection settings, or use a server on this computer.`,
  };
}

export const endpointUrl = (baseUrl: string, path: "models" | "chat/completions"): string => `${baseUrl.replace(/\/+$/, "")}/${path}`;
