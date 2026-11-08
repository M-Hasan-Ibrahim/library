// Unit tests for the admin API client (src/admin/api.js) with a fake fetch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminApiError, createAdminApi, describeError } from "../../src/admin/api.js";

function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === "function" ? answer(url, init) : answer;
  };
  return { fetch, calls };
}
const json = (status, body, extra = {}) => ({ status, ok: status >= 200 && status < 300, type: "cors", json: async () => body, ...extra });

test("reads: credentials, no redirects, never cached, no body", async () => {
  const { fetch, calls } = fakeFetch(json(200, { items: [] }));
  const api = createAdminApi({ baseUrl: "https://api.example", fetch });
  assert.deepEqual(await api.listItems(), { items: [] });
  const { url, init } = calls[0];
  assert.equal(url, "https://api.example/api/admin/items");
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "include");
  assert.equal(init.redirect, "manual");
  assert.equal(init.cache, "no-store");
  assert.equal(init.body, undefined);
  assert.equal(init.headers["Content-Type"], undefined);
});

test("writes: JSON body with the revision, to the exact item path", async () => {
  const { fetch, calls } = fakeFetch(json(200, { item: { id: "itm_a" } }));
  const api = createAdminApi({ baseUrl: "", fetch });
  await api.updateItem("itm_a", { revision: 3, title: "T" });
  await api.publishItem("itm_a", 4);
  await api.restoreItem("itm_a_b", 5, 2);
  await api.deleteItem("itm_a", 6);
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url} ${c.init.body}`), [
    'PATCH /api/admin/items/itm_a {"revision":3,"title":"T"}',
    'POST /api/admin/items/itm_a/publish {"revision":4}',
    'POST /api/admin/items/itm_a_b/restore {"revision":5,"fromRevision":2}',
    'DELETE /api/admin/items/itm_a {"revision":6}',
  ]);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
});

test("ids and revisions are checked before any request", async () => {
  const { fetch, calls } = fakeFetch(json(200, {}));
  const api = createAdminApi({ baseUrl: "", fetch });
  for (const id of ["../session", "itm_A", "itm_a/../../x", "", "itm_"]) {
    await assert.rejects(api.getItem(id), (error) => error.kind === "bad_request");
  }
  await assert.rejects(api.itemRevision("itm_a", 0), (error) => error.kind === "bad_request");
  assert.equal(calls.length, 0);
});

test("failures are classified", async () => {
  const cases = [
    [{ status: 0, ok: false, type: "opaqueredirect", json: async () => null }, "session"],
    [json(302, null), "session"],
    [json(401, { error: "Unauthorized" }), "session"],
    [json(403, { error: "x", code: "forbidden_origin" }), "forbidden"],
    [json(403, null), "session"],
    [json(404, { error: "Item not found", code: "not_found" }), "not_found"],
    [json(409, { error: "changed", code: "conflict", currentRevision: 7 }), "conflict"],
    [json(413, { code: "too_large" }), "too_large"],
    [json(415, { error: "Send JSON" }), "bad_request"],
    [json(422, { code: "validation", fields: { title: "must not be empty" } }), "validation"],
    [json(500, { error: "Internal error" }), "server"],
    [json(503, null), "server"],
  ];
  for (const [answer, kind] of cases) {
    const api = createAdminApi({ baseUrl: "", fetch: fakeFetch(answer).fetch });
    await assert.rejects(api.getItem("itm_a"), (error) => error instanceof AdminApiError && error.kind === kind, `${answer.status} -> ${kind}`);
  }
  const api = createAdminApi({ baseUrl: "", fetch: fakeFetch(json(422, { code: "validation", fields: { title: "bad" } })).fetch });
  const error = await api.createItem({}).catch((e) => e);
  assert.deepEqual(error.fields, { title: "bad" });
  assert.equal(error.code, "validation");
  const conflict = await createAdminApi({ baseUrl: "", fetch: fakeFetch(json(409, { code: "conflict", currentRevision: 7 })).fetch }).getItem("itm_a").catch((e) => e);
  assert.equal(conflict.body.currentRevision, 7);
});

test("no answer: network error or timeout; an empty 200 is a server error", async () => {
  const offline = createAdminApi({ baseUrl: "", fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.listItems(), (error) => error.kind === "network");
  const slow = createAdminApi({ baseUrl: "", fetch: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  await assert.rejects(slow.listItems(), (error) => error.kind === "timeout");
  const empty = createAdminApi({ baseUrl: "", fetch: fakeFetch({ status: 200, ok: true, type: "cors", json: async () => { throw new SyntaxError("x"); } }).fetch });
  await assert.rejects(empty.listItems(), (error) => error.kind === "server");
});

test("every kind has a plain-language description", () => {
  for (const kind of ["session", "network", "timeout", "forbidden", "too_large", "not_found", "conflict", "validation", "bad_request", "server"]) {
    assert.ok(describeError(new AdminApiError(kind)).length > 10, kind);
  }
  assert.equal(describeError(new AdminApiError("bad_request", { body: { error: "Body is not valid JSON" } })), "Body is not valid JSON");
});
