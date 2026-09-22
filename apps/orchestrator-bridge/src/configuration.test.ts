import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeEnvironmentVariableNames, createSecretRedactor, readBridgeConfiguration } from "./configuration.js";

const secret = "s3cret-orchestrator-credential-value";
const complete = {
  [bridgeEnvironmentVariableNames.hubUrl]: "wss://hub.example.com/orchestrator-client",
  [bridgeEnvironmentVariableNames.clientId]: "client-alpha",
  [bridgeEnvironmentVariableNames.clientSecret]: secret
};

test("accepts a complete configuration", () => {
  const result = readBridgeConfiguration(complete);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.configuration, {
    hubUrl: "wss://hub.example.com/orchestrator-client",
    clientId: "client-alpha",
    clientSecret: secret
  });
});

test("refuses every missing variable at once and names each one", () => {
  const result = readBridgeConfiguration({});
  assert.equal(result.ok, false);
  const problems = result.ok ? [] : result.problems;
  for (const name of Object.values(bridgeEnvironmentVariableNames)) {
    assert.ok(problems.some((problem) => problem.includes(name)), `expected a problem naming ${name}`);
  }
});

test("refuses a hub URL that is absent, unparsable, or not a WebSocket scheme", () => {
  for (const hubUrl of ["", "   ", "not a url", "https://hub.example.com", "file:///tmp/hub"]) {
    const result = readBridgeConfiguration({ ...complete, [bridgeEnvironmentVariableNames.hubUrl]: hubUrl });
    assert.equal(result.ok, false, `expected ${JSON.stringify(hubUrl)} to be refused`);
  }
});

test("refuses a credential the client.hello contract would reject", () => {
  const oversizeSecret = "x".repeat(600);
  const result = readBridgeConfiguration({ ...complete, [bridgeEnvironmentVariableNames.clientSecret]: oversizeSecret });
  assert.equal(result.ok, false);
  const problems = result.ok ? [] : result.problems;
  assert.ok(problems.some((problem) => problem.includes("orchestrator-client contract")));
  assert.ok(!problems.join("\n").includes(oversizeSecret), "the refusal must not echo the secret");
});

test("no configuration problem ever contains the secret", () => {
  const environments = [
    {},
    { ...complete, [bridgeEnvironmentVariableNames.hubUrl]: "http://hub.example.com" },
    { ...complete, [bridgeEnvironmentVariableNames.clientId]: "" },
    { ...complete, [bridgeEnvironmentVariableNames.clientSecret]: "x".repeat(600) }
  ];
  for (const environment of environments) {
    const result = readBridgeConfiguration(environment);
    if (result.ok) continue;
    assert.ok(!result.problems.join("\n").includes(secret));
  }
});

test("the redactor removes every occurrence of the secret", () => {
  const redact = createSecretRedactor(secret);
  assert.equal(redact(`hello ${secret} and ${secret}`), "hello [redacted] and [redacted]");
  assert.equal(redact("nothing to hide"), "nothing to hide");
});

test("an empty secret never turns the redactor into a match-everything filter", () => {
  const redact = createSecretRedactor("");
  assert.equal(redact("hub connection error"), "hub connection error");
});
