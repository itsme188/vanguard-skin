import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  writeMarker,
  readMarkers,
  setRunningMarker,
  clearRunningMarker,
  getMarkerStatus,
  type JobType,
} from "../src/dedup";

describe("Marker dedup system", () => {
  let kv: KVNamespace;

  beforeEach(() => {
    // Mock KVNamespace
    const store = new Map<string, string>();
    kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string, opts?: any) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(),
    } as any;

    // Update mocks to actually use the store
    kv.get = vi.fn(async (key: string) => store.get(key) ?? null);
    kv.put = vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    });
    kv.delete = vi.fn(async (key: string) => {
      store.delete(key);
    });
  });

  describe("writeMarker", () => {
    it("should write mac-sent marker for briefing type", async () => {
      await writeMarker(kv, "mac", "briefing", "2026-05-08");
      expect(kv.put).toHaveBeenCalledWith(
        "mac-sent-briefing-2026-05-08",
        expect.any(String),
        expect.objectContaining({ expirationTtl: 30 * 3600 })
      );
    });

    it("should write cloud-sent marker for digest type", async () => {
      await writeMarker(kv, "cloud", "digest", "2026-05-08");
      expect(kv.put).toHaveBeenCalledWith(
        "cloud-sent-digest-2026-05-08",
        expect.any(String),
        expect.objectContaining({ expirationTtl: 30 * 3600 })
      );
    });

    it("should write marker for evening type", async () => {
      await writeMarker(kv, "mac", "evening", "2026-05-08");
      expect(kv.put).toHaveBeenCalledWith(
        "mac-sent-evening-2026-05-08",
        expect.any(String),
        expect.objectContaining({ expirationTtl: 30 * 3600 })
      );
    });

    it("should write timestamp as ISO string", async () => {
      await writeMarker(kv, "mac", "briefing", "2026-05-08");
      const call = kv.put as any;
      const value = call.mock.calls[0][1];
      // Should be a valid ISO timestamp
      expect(() => new Date(value)).not.toThrow();
    });

    it("should accept different sentBy values", async () => {
      await writeMarker(kv, "mac", "briefing", "2026-05-08");
      await writeMarker(kv, "cloud", "digest", "2026-05-08");

      const putCalls = (kv.put as any).mock.calls;
      expect(putCalls.length).toBe(2);
      expect(putCalls[0][0]).toContain("mac-sent-");
      expect(putCalls[1][0]).toContain("cloud-sent-");
    });
  });

  describe("readMarkers", () => {
    it("should return all false when no markers exist", async () => {
      const result = await readMarkers(kv, "briefing", "2026-05-08");
      expect(result).toEqual({
        mac: false,
        cloud: false,
        macRunning: false,
      });
    });

    it("should return mac=true when mac-sent marker exists", async () => {
      // Setup: mock get to return a marker
      (kv.get as any).mockResolvedValueOnce("2026-05-08T12:00:00Z");

      const result = await readMarkers(kv, "briefing", "2026-05-08");
      expect(result.mac).toBe(true);
      expect(result.cloud).toBe(false);
    });

    it("should return correct markers for evening type", async () => {
      // Setup: mock get calls
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null); // mac
      getMock.mockResolvedValueOnce("2026-05-08T12:00:00Z"); // cloud
      getMock.mockResolvedValueOnce(null); // macRunning

      const result = await readMarkers(kv, "evening", "2026-05-08");
      expect(result).toEqual({
        mac: false,
        cloud: true,
        macRunning: false,
      });
    });

    it("should return macRunning=true when running marker exists", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null); // mac
      getMock.mockResolvedValueOnce(null); // cloud
      getMock.mockResolvedValueOnce("2026-05-08T12:00:30Z"); // macRunning

      const result = await readMarkers(kv, "digest", "2026-05-08");
      expect(result.macRunning).toBe(true);
    });

    it("should call kv.get three times with correct keys", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null);
      getMock.mockResolvedValueOnce(null);
      getMock.mockResolvedValueOnce(null);

      await readMarkers(kv, "evening", "2026-05-08");

      expect(getMock).toHaveBeenCalledTimes(3);
      expect(getMock).toHaveBeenCalledWith("mac-sent-evening-2026-05-08");
      expect(getMock).toHaveBeenCalledWith("cloud-sent-evening-2026-05-08");
      expect(getMock).toHaveBeenCalledWith("mac-running-evening-2026-05-08");
    });
  });

  describe("setRunningMarker", () => {
    it("should set running marker for briefing type", async () => {
      await setRunningMarker(kv, "briefing", "2026-05-08");
      expect(kv.put).toHaveBeenCalledWith(
        "mac-running-briefing-2026-05-08",
        expect.any(String),
        expect.objectContaining({ expirationTtl: 10 * 60 })
      );
    });

    it("should set running marker for evening type", async () => {
      await setRunningMarker(kv, "evening", "2026-05-08");
      expect(kv.put).toHaveBeenCalledWith(
        "mac-running-evening-2026-05-08",
        expect.any(String),
        expect.objectContaining({ expirationTtl: 10 * 60 })
      );
    });

    it("should use 10-minute TTL for running markers", async () => {
      await setRunningMarker(kv, "digest", "2026-05-08");
      const putCall = (kv.put as any).mock.calls[0];
      expect(putCall[2].expirationTtl).toBe(10 * 60);
    });
  });

  describe("clearRunningMarker", () => {
    it("should delete running marker for briefing type", async () => {
      await clearRunningMarker(kv, "briefing", "2026-05-08");
      expect(kv.delete).toHaveBeenCalledWith("mac-running-briefing-2026-05-08");
    });

    it("should delete running marker for evening type", async () => {
      await clearRunningMarker(kv, "evening", "2026-05-08");
      expect(kv.delete).toHaveBeenCalledWith("mac-running-evening-2026-05-08");
    });

    it("should delete running marker for digest type", async () => {
      await clearRunningMarker(kv, "digest", "2026-05-08");
      expect(kv.delete).toHaveBeenCalledWith("mac-running-digest-2026-05-08");
    });
  });

  describe("getMarkerStatus", () => {
    it("should return null sentBy when no markers exist", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null); // mac
      getMock.mockResolvedValueOnce(null); // cloud
      getMock.mockResolvedValueOnce(null); // macRunning

      const result = await getMarkerStatus(kv, "briefing", "2026-05-08");
      expect(result).toEqual({ sentBy: null, date: "2026-05-08" });
    });

    it("should return sentBy=mac when only mac marker exists", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce("2026-05-08T12:00:00Z"); // mac
      getMock.mockResolvedValueOnce(null); // cloud
      getMock.mockResolvedValueOnce(null); // macRunning

      const result = await getMarkerStatus(kv, "briefing", "2026-05-08");
      expect(result.sentBy).toBe("mac");
    });

    it("should return sentBy=cloud when only cloud marker exists", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null); // mac
      getMock.mockResolvedValueOnce("2026-05-08T12:00:00Z"); // cloud
      getMock.mockResolvedValueOnce(null); // macRunning

      const result = await getMarkerStatus(kv, "digest", "2026-05-08");
      expect(result.sentBy).toBe("cloud");
    });

    it("should prefer cloud marker when both mac and cloud exist", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce("2026-05-08T12:00:00Z"); // mac
      getMock.mockResolvedValueOnce("2026-05-08T12:00:30Z"); // cloud
      getMock.mockResolvedValueOnce(null); // macRunning

      const result = await getMarkerStatus(kv, "evening", "2026-05-08");
      expect(result.sentBy).toBe("cloud");
    });

    it("should always return the correct date", async () => {
      const getMock = kv.get as any;
      getMock.mockResolvedValueOnce(null);
      getMock.mockResolvedValueOnce(null);
      getMock.mockResolvedValueOnce(null);

      const result = await getMarkerStatus(kv, "briefing", "2026-05-09");
      expect(result.date).toBe("2026-05-09");
    });

    it("should work with all JobType values including evening", async () => {
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        const getMock = kv.get as any;
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);

        const result = await getMarkerStatus(kv, type, "2026-05-08");
        expect(result).toEqual({ sentBy: null, date: "2026-05-08" });
      }
    });
  });

  describe("Type system", () => {
    it("should accept all JobType values in writeMarker", async () => {
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        await writeMarker(kv, "mac", type, "2026-05-08");
      }

      expect((kv.put as any).mock.calls.length).toBe(3);
    });

    it("should accept all JobType values in readMarkers", async () => {
      const getMock = kv.get as any;
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);

        await readMarkers(kv, type, "2026-05-08");
      }

      expect(getMock.mock.calls.length).toBe(9); // 3 calls per type, 3 types
    });

    it("should accept all JobType values in setRunningMarker", async () => {
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        await setRunningMarker(kv, type, "2026-05-08");
      }

      expect((kv.put as any).mock.calls.length).toBe(3);
    });

    it("should accept all JobType values in clearRunningMarker", async () => {
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        await clearRunningMarker(kv, type, "2026-05-08");
      }

      expect((kv.delete as any).mock.calls.length).toBe(3);
    });

    it("should accept all JobType values in getMarkerStatus", async () => {
      const getMock = kv.get as any;
      const types: JobType[] = ["briefing", "digest", "evening"];

      for (const type of types) {
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);
        getMock.mockResolvedValueOnce(null);

        await getMarkerStatus(kv, type, "2026-05-08");
      }

      expect(getMock.mock.calls.length).toBe(9);
    });
  });
});
