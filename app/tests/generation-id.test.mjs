import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationId } from "../src/generation-id.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("generation IDs prefer native randomUUID without reading fallback bytes", () => {
  const id = "7dc23212-7cab-4c04-a381-09e1afc12345";
  const random = { randomUUID() { assert.equal(this, random); return id; }, getRandomValues() { assert.fail("fallback should not run"); } };
  assert.equal(createGenerationId(random), id);
});

test("HTTP-safe getRandomValues fallback uses 128 random bits and formats UUID version and variant", () => {
  let calls = 0;
  const random = { getRandomValues(bytes) {
    assert.equal(this, random);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    calls++;
    return bytes;
  } };
  const id = createGenerationId(random);
  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(id, UUID);
  assert.equal(calls, 1);
});

test("generation IDs never fall back to weak randomness when crypto is unavailable", () => {
  assert.throws(() => createGenerationId(null), /Secure randomness/);
  assert.throws(() => createGenerationId({}), /Secure randomness/);
  assert.throws(() => createGenerationId({ getRandomValues() { throw new Error("crypto unavailable"); } }), /crypto unavailable/);
});
