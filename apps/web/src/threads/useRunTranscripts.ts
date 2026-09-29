import { useEffect, useRef, useState } from "react";
import type { RunTranscript, RunTranscriptResponse } from "@coffee-shop/protocol";

export interface TranscriptRequest {
  runId: string;
  /** Changes whenever the run's transcript may have changed: its activity sequence and status. */
  version: string;
}

export interface TranscriptState {
  transcript?: RunTranscript;
  loaded: boolean;
  failed: boolean;
}

interface RequestRecord {
  fetchedVersion?: string;
  inFlight: boolean;
  lastStartedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Streaming runs change on every event; one fetch per run per interval keeps up without flooding the hub. */
export const transcriptRefreshMilliseconds = 400;

/**
 * Keeps the transcripts of the requested runs current. Each run is fetched when its version first
 * differs from the one last fetched, at most once per refresh interval and never twice at once; a
 * version that changes during a fetch is fetched again when that one settles. A failed fetch is
 * retried only when the version changes again, so an unavailable hub is never polled.
 */
export function useRunTranscripts(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  requests: TranscriptRequest[]
): Record<string, TranscriptState> {
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({});
  const records = useRef(new Map<string, RequestRecord>());
  const wanted = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const fetcher = useRef(apiFetch);
  fetcher.current = apiFetch;
  const key = requests.map((request) => `${request.runId}@${request.version}`).join("|");

  useEffect(() => {
    mounted.current = true;
    const current = records.current;
    return () => {
      mounted.current = false;
      for (const record of current.values()) if (record.timer) clearTimeout(record.timer);
    };
  }, []);

  useEffect(() => {
    wanted.current = new Map(requests.map((request) => [request.runId, request.version]));
    for (const runId of wanted.current.keys()) refresh(runId);
    // `key` captures every request's identity and version.
  }, [key]);

  function refresh(runId: string) {
    const version = wanted.current.get(runId);
    if (version === undefined || !mounted.current) return;
    let record = records.current.get(runId);
    if (!record) {
      record = { inFlight: false, lastStartedAt: 0 };
      records.current.set(runId, record);
    }
    if (record.inFlight || record.timer || record.fetchedVersion === version) return;
    const wait = record.lastStartedAt + transcriptRefreshMilliseconds - Date.now();
    if (wait > 0) {
      const pending = record;
      pending.timer = setTimeout(() => {
        pending.timer = undefined;
        refresh(runId);
      }, wait);
      return;
    }
    const active = record;
    active.inFlight = true;
    active.lastStartedAt = Date.now();
    let failed = false;
    let transcript: RunTranscript | undefined;
    void fetcher.current(`/api/runs/${encodeURIComponent(runId)}/transcript`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`transcript ${response.status}`);
        transcript = (await response.json() as RunTranscriptResponse).transcript;
      })
      .catch(() => { failed = true; })
      .finally(() => {
        active.inFlight = false;
        active.fetchedVersion = version;
        if (!mounted.current) return;
        setTranscripts((previous) => ({
          ...previous,
          // A failed refresh keeps the last transcript that loaded rather than blanking the turn.
          [runId]: failed ? { ...previous[runId], loaded: true, failed: true } : { transcript, loaded: true, failed: false }
        }));
        refresh(runId);
      });
  }

  return transcripts;
}
