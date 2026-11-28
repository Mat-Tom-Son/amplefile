import type { ConnectedFolderIndexStatus } from "../../../src/local/index/indexer";
import type { RecallCoverage, RecallFileHit, RecallHit, RecallResult } from "../../../src/local/index/recall";

/**
 * The preview's sample index: ranked hits for Search, an index status row for
 * each Connected Folder, and Related files for a selected file. The preview has
 * no host, so a search matches a hit when any word of the query appears in it.
 */
export interface ConnectedFolderRecallFixture {
  /** The ranked answer a search for `needle` gets from one Connected Folder. */
  rankedFor: (connectedFolderId: string, needle: string) => RecallResult;
  /** Each Connected Folder's index status, by id. */
  index: Record<string, ConnectedFolderIndexStatus>;
  /** Related files by Connected Folder and path. */
  related: Record<string, Record<string, RecallFileHit[]>>;
}

const counts = (indexed: number, rest: Partial<Record<keyof NonNullable<RecallCoverage["files"]>, number>> = {}): NonNullable<RecallCoverage["files"]> => ({
  indexed, pending: 0, "not-downloaded": 0, binary: 0, "too-large": 0, unsupported: 0, unreadable: 0, ...rest,
});

function coverage(files: RecallCoverage["files"], extra: Partial<RecallCoverage> = {}): RecallCoverage {
  return {
    state: files ? "partial" : "not-indexed", complete: false, files, chatMessages: files ? 340 : null,
    chunks: files ? { total: 5200, embedded: 5200 } : null, embedder: "mac-natural-language", ranking: "hybrid",
    lastSyncAt: null, running: false, walk: files ? { complete: true, stoppedBy: null, excluded: {} } : null, staleHits: 0, ...extra,
  };
}

export function buildConnectedFolderRecallFixture(ids: { home: string; trip: string; bathroom: string }, now: string): ConnectedFolderRecallFixture {
  const hit = (extra: Omit<RecallFileHit, "source" | "reasons" | "sha256" | "indexedAt" | "fresh"> & { reasons?: RecallFileHit["reasons"]; fresh?: boolean }): RecallFileHit =>
    ({ source: "file", reasons: ["lexical", "semantic"], sha256: "0".repeat(64), indexedAt: now, fresh: true, ...extra });
  const homeHits: RecallHit[] = [
    hit({ path: "Kitchen refresh/ideas.md", location: { lines: { start: 12, end: 18 }, headings: ["Contractor quotes"] }, score: 0.032, excerpt: "The fixed-price quote covers cabinets, counters, and labor. Hardware and the backsplash tile are quoted separately, so ask for them in writing." }),
    {
      source: "chat", conversationId: "fixture-chat-1", messageId: "m-4", title: "Compare contractor estimates", role: "assistant", createdAt: now, location: {},
      score: 0.029, reasons: ["semantic"], sha256: "1".repeat(64), indexedAt: now, fresh: true,
      excerpt: "Avery’s estimate is $2,000 higher, but it includes the cabinet hardware and a two-year workmanship guarantee.",
    },
    hit({ path: "Garden/planting-plan.pdf", location: { page: 3 }, score: 0.024, reasons: ["semantic"], excerpt: "Plant the tomatoes after the last frost, with a quote from the nursery on drip irrigation for the raised beds." }),
    hit({ path: "weekend checklist.md", location: { lines: { start: 4, end: 6 } }, score: 0.018, reasons: ["lexical"], fresh: false, excerpt: "Call the contractor about the quote, then pick up primer and painter’s tape." }),
  ];
  const tripHits: RecallHit[] = [
    hit({ path: "Bookings/hotel.pdf", location: { page: 1 }, score: 0.027, excerpt: "Your reservation at the ryokan is confirmed for seven nights. A quote for the airport transfer is attached." }),
    hit({ path: "itinerary.md", location: { lines: { start: 20, end: 26 }, headings: ["Day 3 · Kyoto"] }, score: 0.021, excerpt: "Morning at Fushimi Inari before the crowds, then lunch near the ryokan." }),
  ];
  const bathroomHits: RecallHit[] = [hit({ path: "quote.pdf", location: { page: 2 }, score: 0.03, excerpt: "Tile, labor, and permit fees come to the quote total on page 1; plumbing fixtures are an allowance." })];
  const homeCoverage = coverage(counts(1204, { "not-downloaded": 12, "too-large": 20, unsupported: 24 }), { state: "complete", complete: true, lastSyncAt: now, staleHits: 1 });
  const tripCoverage = coverage(counts(212, { pending: 40 }), { running: true });
  const bathroomCoverage = coverage(counts(18), { state: "complete", complete: true, lastSyncAt: now });
  const sets: Record<string, { hits: RecallHit[]; coverage: RecallCoverage }> = {
    [ids.home]: { hits: homeHits, coverage: homeCoverage },
    [ids.trip]: { hits: tripHits, coverage: tripCoverage },
    [ids.bathroom]: { hits: bathroomHits, coverage: bathroomCoverage },
  };
  return {
    rankedFor(connectedFolderId, needle) {
      const set = sets[connectedFolderId];
      const words = needle.toLocaleLowerCase().split(/\s+/).filter((word) => word.length >= 3);
      const hits = (set?.hits ?? []).filter((item) => {
        const text = `${item.source === "chat" ? item.title : item.path} ${item.excerpt}`.toLocaleLowerCase();
        return words.some((word) => text.includes(word));
      });
      return { query: needle, hits, coverage: set?.coverage ?? coverage(null) };
    },
    index: {
      [ids.home]: { connectedFolderId: ids.home, ...homeCoverage },
      [ids.trip]: { connectedFolderId: ids.trip, ...tripCoverage },
      [ids.bathroom]: { connectedFolderId: ids.bathroom, ...bathroomCoverage },
    },
    related: {
      [ids.home]: {
        "Kitchen refresh/ideas.md": [
          hit({ path: "Kitchen refresh/budget.xlsx", location: { sheet: "Budget", rows: { start: 1, end: 30 } }, score: 0.03, excerpt: "" }),
          hit({ path: "weekend checklist.md", location: {}, score: 0.02, excerpt: "" }),
          hit({ path: "Garden/ideas.md", location: {}, score: 0.015, excerpt: "" }),
        ],
        "Garden/planting-plan.pdf": [hit({ path: "Garden/ideas.md", location: {}, score: 0.03, excerpt: "" })],
      },
    },
  };
}
