import type { Artifact, ArtifactPreview } from "@coffee-shop/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewArtifact, renewalTtlSeconds } from "./PreviewArtifact.js";

const createdAt = "2026-09-27T12:00:00.000Z";
const artifact: Artifact = {
  id: "artifact-one", threadId: "thread-one", runId: "run-one", agentId: "publisher",
  relativePath: ".coffee-shop/previews/site.tar.gz", title: "Launch preview", kind: "preview-bundle",
  mediaType: "application/vnd.coffee-shop.preview-bundle+tar+gzip", summary: "Review the release",
  size: 239, sha256: "a".repeat(64), downloadPath: "/api/artifacts/artifact-one/content",
  uploaded: true, idempotencyKey: "preview-one", createdAt
};

function preview(overrides: Partial<ArtifactPreview> = {}): ArtifactPreview {
  return {
    id: "preview-one", artifactId: artifact.id, artifactSha256: artifact.sha256,
    threadId: "thread-one", runId: "run-one", agentId: "publisher", entrypoint: "site/index.html",
    status: "ready", processingGeneration: 1, createdAt, updatedAt: "2026-09-27T12:02:00.000Z",
    expiresAt: "2026-09-28T12:00:00.000Z", readyAt: "2026-09-27T12:02:00.000Z",
    accessState: "eligible", ...overrides
  };
}

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("PreviewArtifact", () => {
  it("presents the five closed lifecycle states and ready-unavailable without color-only meaning", () => {
    const cases: Array<[ArtifactPreview, string]> = [
      [preview({ status: "upload-pending", processingGeneration: 0, readyAt: undefined, accessState: "unavailable", updatedAt: createdAt }), "Waiting for bundle upload"],
      [preview({ status: "processing", readyAt: undefined, accessState: "unavailable" }), "Preparing preview · generation 1"],
      [preview(), "Ready for isolated access"],
      [preview({ accessState: "unavailable" }), "Access expired/unavailable"],
      [preview({ status: "failed", readyAt: undefined, failedAt: "2026-09-27T12:02:00.000Z", failureCode: "bundle-invalid", accessState: "unavailable" }), "Bundle format is invalid"],
      [preview({ status: "expired", readyAt: undefined, updatedAt: "2026-09-28T12:00:00.000Z", expiredAt: "2026-09-28T12:00:00.000Z", accessState: "unavailable" }), "Preview expired"]
    ];
    const { rerender } = render(<PreviewArtifact artifact={artifact} preview={cases[0]![0]} canMutate apiFetch={vi.fn()} />);
    for (const [value, label] of cases) {
      rerender(<PreviewArtifact artifact={artifact} preview={value} canMutate apiFetch={vi.fn()} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText("Launch preview")).toBeInTheDocument();
      expect(screen.getByText("run-one")).toBeInTheDocument();
      expect(screen.getByText("Agent publisher")).toBeInTheDocument();
    }
  });

  it("labels an instance producer by its exact allocation without agent fallback", () => {
    render(<PreviewArtifact artifact={{ ...artifact, agentId: undefined, instanceId: "instance-one", allocationId: "allocation-one" }}
      preview={preview({ agentId: undefined, instanceId: "instance-one", allocationId: "allocation-one" })}
      canMutate apiFetch={vi.fn()} />);
    expect(screen.getByText("Instance instance-one · allocation allocation-one")).toBeInTheDocument();
    expect(screen.queryByText("Agent publisher")).not.toBeInTheDocument();
  });

  it("exposes only a validated isolated access URL and clears it on identity and freshness changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:04:00.000Z"));
    const apiFetch = vi.fn().mockResolvedValue(response({
      previewId: "preview-one",
      url: "https://preview.example.test/_coffee-shop/preview/v1/capability/site/index.html",
      expiresAt: "2026-09-27T12:05:00.000Z"
    }));
    const { rerender } = render(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={apiFetch} />);
    fireEvent.click(screen.getByRole("button", { name: "Request access to preview Launch preview" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const anchor = screen.getByRole("link", { name: "Open isolated preview Launch preview in a new tab" });
    expect(anchor).toHaveAttribute("target", "_blank");
    expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    expect(apiFetch).toHaveBeenCalledWith("/api/previews/preview-one/access", expect.objectContaining({ body: "{}" }));

    rerender(<PreviewArtifact artifact={artifact} preview={preview({ processingGeneration: 2 })} canMutate apiFetch={apiFetch} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    rerender(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={apiFetch} />);
    fireEvent.click(screen.getByRole("button", { name: /Request access/ }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rerender(<PreviewArtifact artifact={artifact} preview={preview()} canMutate={false} apiFetch={apiFetch} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("drops an access response that races an identity or connection change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:04:00.000Z"));
    const pending = deferred<Response>();
    const { rerender } = render(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={() => pending.promise} />);
    fireEvent.click(screen.getByRole("button", { name: /Request access/ }));
    rerender(<PreviewArtifact artifact={artifact} preview={preview({ processingGeneration: 2 })} canMutate={false} apiFetch={() => pending.promise} />);
    pending.resolve(response({
      previewId: "preview-one",
      url: "https://preview.example.test/_coffee-shop/preview/v1/secret/site/index.html",
      expiresAt: "2026-09-27T12:05:00.000Z"
    }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret");
  });

  it("removes mutation controls when the local lifecycle timer reaches expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:01.000Z"));
    const { rerender } = render(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={vi.fn()} />);
    expect(screen.getByText("Access expired/unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request access/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Renew lifecycle/ })).not.toBeInTheDocument();

    rerender(<PreviewArtifact artifact={artifact} preview={preview({
      status: "failed", readyAt: undefined, failedAt: "2026-09-27T12:02:00.000Z",
      failureCode: "bundle-invalid", accessState: "unavailable"
    })} canMutate apiFetch={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Retry preview/ })).not.toBeInTheDocument();
  });

  it.each([
    { previewId: "wrong", url: "https://preview.example.test/_coffee-shop/preview/v1/token/site/index.html", expiresAt: "2026-09-27T12:05:00.000Z" },
    { previewId: "preview-one", url: "javascript:alert(1)", expiresAt: "2026-09-27T12:05:00.000Z" },
    { previewId: "preview-one", url: `${location.origin}/_coffee-shop/preview/v1/token/site/index.html`, expiresAt: "2026-09-27T12:05:00.000Z" },
    { previewId: "preview-one", url: "https://preview.example.test/not-preview/token", expiresAt: "2026-09-27T12:05:00.000Z" },
    { previewId: "preview-one", url: "https://preview.example.test/_coffee-shop/preview/v1/token/site/index.html", expiresAt: "2026-09-29T12:05:00.000Z" },
    { previewId: "preview-one", url: "https://preview.example.test/_coffee-shop/preview/v1/token/site/index.html", expiresAt: "2026-09-27T12:05:00.000Z", extra: true }
  ])("fails closed on malformed access response %#", async (body) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:04:00.000Z"));
    render(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={vi.fn().mockResolvedValue(response(body))} />);
    fireEvent.click(screen.getByRole("button", { name: /Request access/ }));
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Preview access unavailable")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(String(body.url));
  });

  it("sends bounded renewal and retry requests but waits for snapshot lifecycle state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:06:00.000Z"));
    const renewed = preview({ expiresAt: "2026-09-28T12:06:00.000Z", updatedAt: "2026-09-27T12:06:00.000Z" });
    const apiFetch = vi.fn().mockResolvedValue(response({ preview: renewed }));
    const { rerender } = render(<PreviewArtifact artifact={artifact} preview={preview()} canMutate apiFetch={apiFetch} />);
    fireEvent.click(screen.getByRole("button", { name: "Renew lifecycle for preview Launch preview" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiFetch).toHaveBeenCalledWith("/api/previews/preview-one/renew", expect.objectContaining({
      body: JSON.stringify({ ttlSeconds: 86_400 })
    }));
    expect(screen.getByText(/Renewal accepted/)).toBeInTheDocument();
    expect(screen.getByText("2026-09-28T12:00:00.000Z")).toBeInTheDocument();

    const failed = preview({ status: "failed", readyAt: undefined, failedAt: "2026-09-27T12:02:00.000Z", failureCode: "bundle-invalid", accessState: "unavailable" });
    apiFetch.mockResolvedValueOnce(response({ preview: { ...failed, status: "processing", processingGeneration: 2, failedAt: undefined, failureCode: undefined, updatedAt: "2026-09-27T12:04:00.000Z" }, replayed: false }));
    rerender(<PreviewArtifact artifact={artifact} preview={failed} canMutate apiFetch={apiFetch} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview Launch preview" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(apiFetch).toHaveBeenCalledWith("/api/previews/preview-one/retry", expect.objectContaining({ body: "{}" }));
    expect(screen.getByText(/Retry accepted/)).toBeInTheDocument();
    expect(screen.getByText("Bundle format is invalid")).toBeInTheDocument();
  });
});

describe("renewalTtlSeconds", () => {
  it("uses the default window, maximum lifetime, and minimum extension", () => {
    const now = Date.parse("2026-09-27T12:06:00.000Z");
    expect(renewalTtlSeconds(preview(), now)).toBe(86_400);
    expect(renewalTtlSeconds(preview({ expiresAt: "2026-10-04T11:59:00.000Z" }), now)).toBeUndefined();
  });
});
