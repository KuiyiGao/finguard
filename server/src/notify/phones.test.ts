import assert from "node:assert/strict";
import test from "node:test";
import { parsePhones } from "./phones.ts";

test("several phones, each with an optional Photon line", () => {
  assert.deepEqual(parsePhones({ STEWARD_USER_HANDLE: "+15550100001, +15550100002@+15550100099" }), [
    { id: 1, handle: "+15550100001" },
    { id: 2, handle: "+15550100002", line: "+15550100099" },
  ]);
  assert.deepEqual(parsePhones({}), []);
});
