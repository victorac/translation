import { describe, expect, it } from "vitest";
import { checkEndpointAllowed, endpointUrl, parseEndpoint } from "./endpoint.js";

describe("parseEndpoint", () => {
  it("accepts the usual local addresses and normalizes the trailing slash", () => {
    expect(parseEndpoint("http://localhost:1234/v1")).toMatchObject({ ok: true, baseUrl: "http://localhost:1234/v1", loopback: true });
    expect(parseEndpoint(" http://127.0.0.1:1234/v1/ ")).toMatchObject({ ok: true, baseUrl: "http://127.0.0.1:1234/v1", loopback: true });
    expect(parseEndpoint("http://[::1]:1234/v1")).toMatchObject({ ok: true, loopback: true });
  });

  it("treats everything else as remote", () => {
    for (const u of ["http://192.168.1.20:1234/v1", "https://api.example.com/v1", "http://localhost.evil.com/v1", "http://127.0.0.2:1234/v1"]) {
      expect(parseEndpoint(u)).toMatchObject({ ok: true, loopback: false });
    }
  });

  it("rejects bad schemes, embedded credentials, queries and nonsense", () => {
    for (const u of ["ftp://localhost/v1", "file:///etc/passwd", "javascript:alert(1)", "http://user:pw@localhost:1234/v1", "http://localhost/v1?x=1", "http://localhost/v1#top", "", "not a url"]) {
      expect(parseEndpoint(u).ok).toBe(false);
    }
  });

  it("explains each rejection in plain words", () => {
    expect(parseEndpoint("http://user:pw@localhost/v1")).toMatchObject({ message: expect.stringContaining("API key field") });
    expect(parseEndpoint("ftp://x")).toMatchObject({ message: expect.stringContaining("http://") });
  });
});

describe("checkEndpointAllowed", () => {
  it("allows this computer, blocks other hosts until approved by host and port", () => {
    expect(checkEndpointAllowed("http://localhost:1234/v1", new Set()).ok).toBe(true);
    const blocked = checkEndpointAllowed("http://192.168.1.20:1234/v1", new Set());
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.message).toContain("192.168.1.20:1234");
    expect(checkEndpointAllowed("http://192.168.1.20:1234/v1", new Set(["192.168.1.20:1234"])).ok).toBe(true);
    expect(checkEndpointAllowed("http://192.168.1.20:9999/v1", new Set(["192.168.1.20:1234"])).ok).toBe(false);
  });
});

describe("endpointUrl", () => {
  it("appends the path exactly once", () => {
    expect(endpointUrl("http://localhost:1234/v1", "models")).toBe("http://localhost:1234/v1/models");
    expect(endpointUrl("http://localhost:1234/v1/", "chat/completions")).toBe("http://localhost:1234/v1/chat/completions");
  });
});
