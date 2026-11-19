import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { request as httpsRequest, RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress, NodeHttpsTransport } from "../src/graph/node-http.js";
import type { HttpRequest } from "../src/graph/types.js";

const input: HttpRequest = { url: "https://graph.microsoft.com/v1.0/me/messages", method: "GET", headers: { authorization: "Bearer synthetic" }, maxBytes: 8, timeoutMs: 1000 };
afterEach(() => vi.useRealTimers());
function fakeHttps(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const destroy = vi.fn();
  const request = vi.fn((_url: URL, _options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const outgoing = new EventEmitter() as ClientRequest;
    outgoing.destroy = (() => { destroy(); return outgoing; }) as ClientRequest["destroy"];
    outgoing.end = (() => {
      queueMicrotask(() => {
        const response = Readable.from(chunks) as IncomingMessage;
        response.statusCode = 200; response.headers = headers; callback(response);
      });
      return outgoing;
    }) as ClientRequest["end"];
    return outgoing;
  });
  return { request, destroy, transport: new NodeHttpsTransport(async () => [{ address: "20.190.128.1", family: 4 }], request as unknown as typeof httpsRequest) };
}

describe("production HTTPS address boundary", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.1.1", "192.168.1.2", "0.0.0.0", "100.64.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::1"])("rejects nonpublic address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("accepts global IPv4/IPv6 and pins resolution without a second DNS lookup", async () => {
    expect(isPublicAddress("20.190.128.1")).toBe(true); expect(isPublicAddress("2603:1036:3000::1")).toBe(true);
    const { request } = fakeHttps([Buffer.from("ok")]);
    const resolve = vi.fn(async () => [{ address: "20.190.128.1", family: 4 }]);
    const transport = new NodeHttpsTransport(resolve, request as unknown as typeof httpsRequest);
    await expect(transport.send(input)).resolves.toMatchObject({ status: 200, body: Buffer.from("ok") });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("graph.microsoft.com");
    const options = request.mock.calls[0]![1]; const callback = vi.fn();
    options.lookup!("graph.microsoft.com", { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, "20.190.128.1", 4);
    expect(options.servername).toBe("graph.microsoft.com"); expect(options.agent).toBe(false);
    expect(resolve).toHaveBeenCalledOnce();
  });
  it("rejects mixed public/private DNS answers and literal destinations before HTTPS dispatch", async () => {
    const { request } = fakeHttps([]);
    const resolve = vi.fn(async () => [{ address: "20.190.128.1", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    const transport = new NodeHttpsTransport(resolve, request as unknown as typeof httpsRequest);
    await expect(transport.send(input)).rejects.toMatchObject({ code: "endpoint_denied", dispatched: false });
    for (const url of ["http://graph.microsoft.com/", "https://127.0.0.1/", "https://[::1]/", "https://user@graph.microsoft.com/", "https://graph.microsoft.com:444/", "https://graph.microsoft.com/#fragment"]) {
      await expect(transport.send({ ...input, url })).rejects.toMatchObject({ code: "endpoint_denied", dispatched: false });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("counts streamed bytes even without Content-Length and aborts oversized payloads", async () => {
    const { transport, destroy } = fakeHttps([Buffer.alloc(5), Buffer.alloc(5)]);
    await expect(transport.send(input)).rejects.toMatchObject({ code: "size_limit", dispatched: true });
    expect(destroy).toHaveBeenCalledOnce();
    await expect(fakeHttps([Buffer.alloc(2)], { "content-length": "1000" }).transport.send(input)).rejects.toMatchObject({ code: "size_limit" });
    await expect(fakeHttps([Buffer.alloc(2)], { "content-encoding": "gzip" }).transport.send(input)).rejects.toMatchObject({ code: "response_invalid" });
  });
  it("bounds unresolved DNS and never dispatches after a late lookup or abort", async () => {
    vi.useFakeTimers();
    const { request } = fakeHttps([]); let release!: (value: Array<{ address: string; family: number }>) => void;
    const transport = new NodeHttpsTransport(() => new Promise((resolve) => { release = resolve; }), request as unknown as typeof httpsRequest);
    const pending = expect(transport.send({ ...input, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout", dispatched: false });
    await vi.advanceTimersByTimeAsync(20); await pending;
    release([{ address: "20.190.128.1", family: 4 }]); await Promise.resolve(); expect(request).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error("private reason"));
    await expect(transport.send({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "aborted", dispatched: false });
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("suppresses DNS exception details", async () => {
    const transport = new NodeHttpsTransport(async () => { throw new Error("private DNS endpoint"); });
    await expect(transport.send(input)).rejects.toMatchObject({ message: "network", dispatched: false });
  });
});
