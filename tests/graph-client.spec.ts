import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphClient, retryAfterSeconds } from "../src/graph/client.js";
import { GraphError, HttpFailure, FILE_LIMIT, JSON_LIMIT, type GraphRequest, type HttpResponse } from "../src/graph/types.js";
import { operationTypes } from "../src/governance/types.js";
import { validateNextLink, validateRequest } from "../src/graph/endpoints.js";

const binding = { companyId: "company", agentId: "agent", projectId: "project", connectionId: "connection", generation: 1, tenantId: "tenant", homeAccountId: "account" };
const read: GraphRequest = { binding, operationType: "mail-list-messages", method: "GET", path: "/me/mailFolders/inbox/messages" };
const mutation: GraphRequest = { binding, operationType: "mail-send", method: "POST", path: "/me/sendMail", body: { message: { subject: "synthetic" } } };
const download: GraphRequest = { binding, operationType: "drive-read-content", method: "GET", path: "/me/drive/items/file/content" };
function response(status = 200, data: unknown = { value: [] }, headers: HttpResponse["headers"] = {}): HttpResponse {
  return { status, headers, body: data === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(data)) };
}
const clients: GraphClient[] = [];
function setup(options: Partial<ConstructorParameters<typeof GraphClient>[0]> = {}) {
  const send = vi.fn().mockResolvedValue(response());
  const authorize = vi.fn().mockResolvedValue("synthetic-bearer");
  let now = Date.parse("2026-11-19T00:00:00Z");
  const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
  const emit = vi.fn();
  const client = new GraphClient({ http: { send }, authorize, now: () => now, sleep, emit, ...options });
  clients.push(client);
  return { client, send, authorize, sleep, emit, advance: (milliseconds: number) => { now += milliseconds; } };
}
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); });

describe("Graph endpoint boundary", () => {
  it("allows only narrow metadata aliases and fixed Outlook preferences", () => {
    for (const path of ["/me/mailFolders/drafts", "/me/mailFolders/deleteditems"]) expect(validateRequest({ ...read, operationType: "mail-list-folders", path }).scopes).toEqual(["Mail.Read"]);
    expect(validateRequest({ ...read, operationType: "calendar-list-calendars", path: "/me/outlook/supportedTimeZones" }).scopes).toEqual(["User.Read"]);
    expect(validateRequest({ ...read, operationType: "drive-get-item", path: "/me/drive/root" }).scopes).toEqual(["Files.Read"]);
    expect(validateRequest({ ...read, headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } }).headers.prefer).toContain("ImmutableId");
    for (const prefer of ['IdType="MutableId"', 'outlook.body-content-type="html"', 'IdType="ImmutableId", arbitrary="value"']) expect(() => validateRequest({ ...read, headers: { Prefer: prefer } })).toThrow();
    const file: GraphRequest = { ...read, operationType: "drive-create-file", method: "PUT", path: "/me/drive/items/parent:/file%20name.txt:/content", query: { "@microsoft.graph.conflictBehavior": "fail" }, body: new Uint8Array() };
    expect(validateRequest(file).url).toContain("file%20name.txt");
    for (const path of ["/me/drive/items/parent%20id:/file.txt:/content", "/me/drive/items/parent:/file%2Fname:/content", "/me/drive/items/parent:/%2E%2E:/content"]) expect(() => validateRequest({ ...file, path })).toThrow();
  });
  it("emits an explicit throttling classification without content", async () => {
    const f = setup(); f.send.mockResolvedValue(response(429, {}, { "retry-after": "61" }));
    await expect(f.client.request(read)).rejects.toMatchObject({ code: "throttled" });
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ errorClass: "throttled", statusClass: "4xx", retryAfterSeconds: 61 }));
  });
  it("covers every declared operation with only its documented method and own-account route", () => {
    const matrix: Array<[GraphRequest["operationType"], GraphRequest["method"], string]> = [
      ["mail-list-folders", "GET", "/me/mailFolders"], ["mail-list-messages", "GET", "/me/mailFolders/f/messages"],
      ["mail-list-attachments", "GET", "/me/messages/m/attachments"], ["mail-download-attachment", "GET", "/me/messages/m/attachments/a/$value"],
      ["mail-get-message", "GET", "/me/messages/m"], ["mail-create-draft", "POST", "/me/messages"],
      ["mail-update-draft", "PATCH", "/me/messages/m"], ["mail-create-reply-draft", "POST", "/me/messages/m/createReply"],
      ["mail-send", "POST", "/me/sendMail"], ["mail-delete", "DELETE", "/me/messages/m"],
      ["calendar-list-calendars", "GET", "/me/calendars"], ["calendar-list-events", "GET", "/me/calendars/c/calendarView"],
      ["calendar-get-event", "GET", "/me/calendars/c/events/e"], ["calendar-create-event", "POST", "/me/calendars/c/events"],
      ["calendar-update-event", "PATCH", "/me/calendars/c/events/e"], ["calendar-delete-event", "DELETE", "/me/calendars/c/events/e"],
      ["drive-list-children", "GET", "/me/drive/items/p/children"], ["drive-get-item", "GET", "/me/drive/items/i"],
      ["drive-read-content", "GET", "/me/drive/items/i/content"], ["drive-create-folder", "POST", "/me/drive/items/p/children"],
      ["drive-create-file", "PUT", "/me/drive/items/p:/file.txt:/content"], ["drive-replace-content", "PUT", "/me/drive/items/i/content"],
      ["drive-rename-item", "PATCH", "/me/drive/items/i"], ["drive-delete-item", "DELETE", "/me/drive/items/i"],
    ];
    expect(matrix.map(([operation]) => operation).sort()).toEqual([...operationTypes].sort());
    for (const [operationType, method, path] of matrix) {
      const input: GraphRequest = { binding, operationType, method, path,
        ...(operationType === "mail-list-attachments" ? { query: { $select: "id,name,contentType,size,isInline,lastModifiedDateTime" } } : {}),
        ...(method === "GET" || method === "DELETE" ? {} : { body: method === "PUT" ? new Uint8Array([1]) : {} }),
        ...(method === "GET" ? {} : { headers: { "If-Match": '"synthetic-etag"' } }),
        ...(operationType === "calendar-list-events" ? { query: { startDateTime: "2026-11-01T00:00:00Z", endDateTime: "2026-12-01T00:00:00Z" } } : {}),
        ...(operationType === "drive-create-file" ? { query: { "@microsoft.graph.conflictBehavior": "fail" } } : {}),
      };
      expect(validateRequest(input).url).toMatch(/^https:\/\/graph.microsoft.com\/v1.0\/me\//);
      expect(() => validateRequest({ ...input, method: method === "GET" ? "POST" : "GET" })).toThrow("endpoint_denied");
    }
  });

  it.each(["https://evil.test/me/messages", "/users/other/messages", "/me/mailFolders/%2e%2e/messages", "/me/mailFolders/%2fsecret/messages", "/me/mailFolders/a\\b/messages", "/me/mailFolders/a?x/messages"])("rejects endpoint escape %s before authorization", async (path) => {
    const { client, send, authorize } = setup();
    await expect(client.request({ ...read, path })).rejects.toMatchObject({ code: "endpoint_denied" });
    expect(authorize).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it("rejects arbitrary query/headers and enforces upload/body sizes", async () => {
    const { client, send } = setup();
    const invalidPatches: Partial<GraphRequest>[] = [{ query: { "$expand": "messages" } }, { headers: { Authorization: "injected" } }, { headers: { "If-Match": '"x"\r\nAuthorization: injected' } }];
    for (const patch of invalidPatches) {
      await expect(client.request({ ...read, ...patch })).rejects.toMatchObject({ code: "request_invalid" });
    }
    await expect(client.request({ ...mutation, body: "x".repeat(JSON_LIMIT) })).rejects.toMatchObject({ code: "size_limit" });
    await expect(client.request({ binding, operationType: "drive-replace-content", method: "PUT", path: "/me/drive/items/f/content", headers: { "If-Match": '"etag"' }, body: new Uint8Array(FILE_LIMIT + 1) })).rejects.toMatchObject({ code: "size_limit" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Graph retries, failures and authority", () => {
  it.each([[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [409, "conflict"], [412, "precondition_failed"]])("maps HTTP %s without provider text or retries", async (status, code) => {
    const { client, send, emit } = setup(); send.mockResolvedValue(response(Number(status), { error: { message: "private provider text", code: "private code" } }));
    await expect(client.request(read)).rejects.toMatchObject({ code, mutationOutcome: "failed" });
    expect(send).toHaveBeenCalledOnce(); expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
  });
  it("respects seconds/date Retry-After and reacquires authority for every bounded attempt", async () => {
    const { client, send, authorize, sleep } = setup();
    send.mockResolvedValueOnce(response(429, {}, { "retry-after": "2" })).mockResolvedValueOnce(response(503, {}, { "retry-after": "Thu, 19 Nov 2026 00:00:05 GMT" })).mockResolvedValueOnce(response());
    await expect(client.request(read)).resolves.toMatchObject({ complete: true });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 3000]);
    expect(authorize).toHaveBeenCalledTimes(3); expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map(([request]) => request.headers["client-request-id"])).size).toBe(3);
    expect(retryAfterSeconds("nonsense", Date.now())).toBeUndefined();
    expect(retryAfterSeconds("1.5", Date.now())).toBeUndefined();
    expect(retryAfterSeconds("999999999999999999999999999999999999999", Date.now())).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("does not retry earlier than a Retry-After exceeding its total budget", async () => {
    const { client, send, sleep } = setup(); send.mockResolvedValue(response(429, {}, { "retry-after": "120" }));
    await expect(client.request(read)).rejects.toMatchObject({ code: "throttled" });
    expect(send).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
  });
  it("bounds read network/5xx retries and stops when authority is revoked", async () => {
    const first = setup(); first.send.mockRejectedValue(new HttpFailure("network", true));
    await expect(first.client.request(read)).rejects.toMatchObject({ code: "network" }); expect(first.send).toHaveBeenCalledTimes(3);
    const second = setup(); second.send.mockResolvedValue(response(500));
    await expect(second.client.request(read)).rejects.toMatchObject({ code: "server_error" }); expect(second.send).toHaveBeenCalledTimes(3);
    const third = setup(); third.send.mockResolvedValue(response(503)); third.authorize.mockResolvedValueOnce("synthetic").mockRejectedValueOnce(new Error("private revoked token"));
    await expect(third.client.request(read)).rejects.toMatchObject({ code: "authority_unavailable" }); expect(third.send).toHaveBeenCalledOnce();
  });
  it.each([429, 500, 503])("never repeats mutation HTTP %s", async (status) => {
    const { client, send, sleep } = setup(); send.mockResolvedValue(response(status));
    await expect(client.request(mutation)).rejects.toMatchObject({ mutationOutcome: status >= 500 ? "unknown" : "failed" });
    expect(send).toHaveBeenCalledOnce(); expect(sleep).not.toHaveBeenCalled();
  });
  it("distinguishes pre-dispatch rejection from uncertain mutation failure and preserves 202 acceptance", async () => {
    const { client, send } = setup();
    send.mockRejectedValueOnce(new HttpFailure("endpoint_denied", false));
    await expect(client.request(mutation)).rejects.toMatchObject({ mutationOutcome: "failed" });
    send.mockRejectedValueOnce(new HttpFailure("network", true));
    await expect(client.request(mutation)).rejects.toMatchObject({ code: "network", mutationOutcome: "unknown" });
    send.mockResolvedValueOnce({ status: 202, headers: {}, body: new Uint8Array() });
    await expect(client.request(mutation)).resolves.toMatchObject({ status: 202, data: null });
  });
  it("aborts before dispatch and during retry backoff without another HTTP call", async () => {
    const controller = new AbortController(); const first = setup(); controller.abort();
    await expect(first.client.request(read, controller.signal)).rejects.toMatchObject({ code: "aborted" }); expect(first.send).not.toHaveBeenCalled();
    const running = new AbortController(); const second = setup({ sleep: async () => { running.abort(); } });
    second.send.mockResolvedValue(response(429, {}, { "retry-after": "1" }));
    await expect(second.client.request(read, running.signal)).rejects.toMatchObject({ code: "aborted" }); expect(second.send).toHaveBeenCalledOnce();
  });
  it("bounds hung authority/HTTP calls and reports dispatched mutation timeout as unknown", async () => {
    vi.useFakeTimers();
    const first = setup({ timeoutMs: 100 }); first.authorize.mockImplementation(() => new Promise(() => undefined));
    const auth = expect(first.client.request(read)).rejects.toMatchObject({ code: "timeout", mutationOutcome: "failed" });
    await vi.advanceTimersByTimeAsync(100); await auth; expect(first.send).not.toHaveBeenCalled();
    const second = setup({ timeoutMs: 100 }); second.send.mockImplementation(() => new Promise(() => undefined));
    const write = expect(second.client.request(mutation)).rejects.toMatchObject({ code: "timeout", mutationOutcome: "unknown" });
    await vi.advanceTimersByTimeAsync(100); await write; expect(second.send).toHaveBeenCalledOnce();
  });
  it("rejects oversized/malformed responses and Graph redirects without following them", async () => {
    const { client, send } = setup();
    send.mockResolvedValueOnce({ status: 200, headers: {}, body: new Uint8Array(JSON_LIMIT + 1) });
    await expect(client.request(read)).rejects.toMatchObject({ code: "size_limit" });
    send.mockResolvedValueOnce({ status: 200, headers: {}, body: Buffer.from("invalid json private body") });
    await expect(client.request(read)).rejects.toMatchObject({ code: "response_invalid" });
    send.mockResolvedValueOnce(response(302, {}, { location: "https://evil.test/" }));
    await expect(client.request(read)).rejects.toMatchObject({ code: "redirect_denied" }); expect(send).toHaveBeenCalledTimes(3);
  });
  it("disposal aborts pending requests and forbids new calls", async () => {
    const { client, send } = setup(); send.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = expect(client.request(mutation)).rejects.toMatchObject({ code: "aborted", mutationOutcome: "unknown" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    client.dispose(); await pending;
    await expect(client.request(read)).rejects.toMatchObject({ code: "aborted" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("keeps successful writes unknown when local response validation fails, without replay", async () => {
    const { client, send } = setup();
    let nested: unknown = { private: "synthetic-canary" };
    for (let i = 0; i < 66; i++) nested = { child: nested };
    for (const data of [nested, { value: [], "@odata.nextLink": "https://evil.test/private" }]) {
      send.mockResolvedValueOnce(response(202, data));
      await expect(client.request(mutation)).rejects.toMatchObject({ code: "response_invalid", mutationOutcome: "unknown", status: 202 });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("opaque pagination and download boundaries", () => {
  const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=opaque";
  it("accepts the same Outlook folder key in an OData next link without rewriting its URL", async () => {
    const { client, send, authorize } = setup();
    const request = { ...read, path: "/me/mailFolders/AaBb%3D/messages", query: { "$top": "1", "$select": "id" } };
    const providerNext = "https://graph.microsoft.com/v1.0/me/mailFolders('AaBb=')/messages?$select=id&$top=1&$skip=1";
    send.mockResolvedValueOnce(response(200, { value: [{ id: "first" }], "@odata.nextLink": providerNext }))
      .mockResolvedValueOnce(response(200, { value: [{ id: "second" }] }));
    const first = await client.request(request);
    expect(first).toMatchObject({ data: { value: [{ id: "first" }] }, complete: false });
    expect(first.continuation).toBeTruthy();
    const last = await client.request({ ...request, continuation: first.continuation });
    expect(last.complete).toBe(true); expect(send.mock.calls[1]![0].url).toBe(providerNext);
    expect(authorize).toHaveBeenCalledTimes(2);
  });
  it.each([
    "/v1.0/me/mailFolders('aabb=')/messages", "/v1.0/me/mailFolders('foreign')/messages",
    "/v1.0/users/foreign/mailFolders('AaBb=')/messages", "/beta/me/mailFolders('AaBb=')/messages",
    "/v1.0/me/mailFolders('AaBb=')/childFolders", "/v1.0/me/mailFolders('AaBb%252F')/messages",
  ])("rejects changed OData folder, identity, version or collection", (path) => {
    expect(() => validateNextLink(`https://graph.microsoft.com${path}?$skip=1`, "https://graph.microsoft.com/v1.0/me/mailFolders/AaBb%3D/messages")).toThrow("continuation_invalid");
  });
  it.each([
    ["not-a-url", "next_link_format"],
    ["https://evil.test/private-canary", "next_link_origin"],
    [next.replace("inbox", "foreign"), "next_link_path"],
    [`${next}&$expand=private-canary`, "next_link_added_parameter"],
    [`${next}&$select=private-canary`, "next_link_changed_parameter"],
    [`${next}&$select=id&$select=id`, "next_link_duplicate_parameter"],
    [next, "next_link_missing_parameter"],
  ])("classifies rejected next links with a fixed diagnostic", (link, diagnostic) => {
    try { validateNextLink(link!, "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=id"); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toMatchObject({ code: "continuation_invalid", diagnostic });
      expect(JSON.stringify(error)).not.toContain("private-canary");
    }
  });
  it("continues an empty page using the complete returned URL while hiding bearer-like annotations", async () => {
    const { client, send } = setup();
    send.mockResolvedValueOnce(response(200, { value: [], "@odata.nextLink": next })).mockResolvedValueOnce(response(200, { value: [{ id: "x", "@microsoft.graph.downloadUrl": "private-link" }] }));
    const first = await client.request(read); expect(first.complete).toBe(false); expect(first.data).toEqual({ value: [] }); expect(first.continuation).toBeTruthy();
    const final = await client.request({ ...read, continuation: first.continuation });
    expect(send.mock.calls[1]![0].url).toBe(next); expect(final).toMatchObject({ complete: true, data: { value: [{ id: "x" }] } });
    await expect(client.request({ ...read, continuation: first.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
  });
  it.each(["companyId", "agentId", "projectId", "connectionId", "generation", "tenantId", "homeAccountId"] as const)("binds continuation to %s", async (field) => {
    const { client, send } = setup(); send.mockResolvedValue(response(200, { value: [], "@odata.nextLink": next }));
    const first = await client.request(read);
    await expect(client.request({ ...read, binding: { ...binding, [field]: field === "generation" ? 2 : "foreign" }, continuation: first.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
    expect(send).toHaveBeenCalledOnce();
  });
  it("binds query and rejects foreign, changed-resource or injected-query next links", async () => {
    for (const link of ["https://evil.test/steal", next.replace("inbox", "foreign"), `${next}&$expand=messages`, "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages", next.replace("https://", "https://user@")]) {
      const { client, send } = setup(); send.mockResolvedValue(response(200, { value: [], "@odata.nextLink": link }));
      await expect(client.request(read)).rejects.toBeInstanceOf(GraphError); expect(send).toHaveBeenCalledOnce();
    }
    const { client, send } = setup(); send.mockResolvedValue(response(200, { value: [], "@odata.nextLink": next }));
    const first = await client.request(read);
    await expect(client.request({ ...read, query: { "$top": "1" }, continuation: first.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
  });
  it("expires continuation, rejects restarts, and reports finite paging as incomplete", async () => {
    const { client, send, advance } = setup({ continuationTtlMs: 100, maxPages: 2 });
    send.mockResolvedValueOnce(response(200, { value: [], "@odata.nextLink": next })).mockResolvedValueOnce(response(200, { value: [], "@odata.nextLink": next + "2" }));
    const first = await client.request(read);
    await expect(setup().client.request({ ...read, continuation: first.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
    const last = await client.request({ ...read, continuation: first.continuation }); expect(last.complete).toBe(false); expect(last.continuation).toBeUndefined();
    send.mockResolvedValueOnce(response(200, { value: [], "@odata.nextLink": next }));
    const expiring = await client.request(read); advance(101);
    await expect(client.request({ ...read, continuation: expiring.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
  });
  it("bounds continuation capacity and rejects paging loops", async () => {
    const { client, send } = setup({ maxContinuations: 1 }); send.mockResolvedValue(response(200, { value: [], "@odata.nextLink": next }));
    const first = await client.request(read);
    await expect(client.request(read)).rejects.toMatchObject({ code: "capacity_exceeded" });
    await expect(client.request({ ...read, continuation: first.continuation })).rejects.toMatchObject({ code: "continuation_invalid" });
  });
  it("strips bearer headers on exact-host download redirects and revalidates authority", async () => {
    const { client, send, authorize } = setup({ downloadHosts: ["download.example.test"] });
    send.mockResolvedValueOnce(response(302, {}, { location: "https://download.example.test/file?signature=synthetic" })).mockResolvedValueOnce({ status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) });
    expect(await client.download(download)).toEqual(new Uint8Array([1, 2, 3]));
    expect(send.mock.calls[0]![0].headers.authorization).toBe("Bearer synthetic-bearer");
    expect(send.mock.calls[1]![0].headers).toEqual({ accept: "application/octet-stream" }); expect(authorize).toHaveBeenCalledTimes(2);
  });
  it("blocks foreign download hosts, redirect loops, large bodies and revoked handoffs", async () => {
    const a = setup({ downloadHosts: ["download.example.test"] }); a.send.mockResolvedValue(response(302, {}, { location: "https://download.example.test.evil.test/file" }));
    await expect(a.client.download(download)).rejects.toMatchObject({ code: "redirect_denied" }); expect(a.send).toHaveBeenCalledOnce();
    const b = setup({ downloadHosts: ["download.example.test"] }); b.send.mockResolvedValue(response(302, {}, { location: "https://download.example.test/file" }));
    await expect(b.client.download(download)).rejects.toMatchObject({ code: "redirect_denied" }); expect(b.send).toHaveBeenCalledTimes(2);
    const c = setup(); c.send.mockResolvedValue({ status: 200, headers: {}, body: new Uint8Array(FILE_LIMIT + 1) });
    await expect(c.client.download(download)).rejects.toMatchObject({ code: "size_limit" });
    const d = setup({ downloadHosts: ["download.example.test"] }); d.send.mockResolvedValue(response(302, {}, { location: "https://download.example.test/file" })); d.authorize.mockResolvedValueOnce("synthetic").mockRejectedValueOnce(new Error("revoked"));
    await expect(d.client.download(download)).rejects.toMatchObject({ code: "authority_unavailable" }); expect(d.send).toHaveBeenCalledOnce();
  });
});


describe("attachment transport", () => {
  const attachment: GraphRequest = { binding, operationType: "mail-download-attachment", method: "GET", path: "/me/messages/m/attachments/a/$value" };
  it("prevents JSON reads from bypassing the download boundary", async () => {
    const f = setup(); await expect(f.client.request(attachment)).rejects.toThrow(); expect(f.send).not.toHaveBeenCalled();
  });
  it("rejects redirects without forwarding the bearer or following the location", async () => {
    const f = setup(); f.send.mockResolvedValue(response(302, null, { location: "https://evil.test/attachment" }));
    await expect(f.client.download(attachment)).rejects.toThrow("redirect_denied"); expect(f.send).toHaveBeenCalledOnce();
  });
  it("rejects attachment metadata queries that request file content", () => {
    expect(() => validateRequest({ ...attachment, operationType: "mail-list-attachments", path: "/me/messages/m/attachments", query: { $select: "id,contentBytes" } })).toThrow();
  });
});
