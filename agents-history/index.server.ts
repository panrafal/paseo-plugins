import type { PluginServerContext } from "@getpaseo/plugin";
import { buildCensus, clearCensusCaches } from "./server/census";
import { abortAllSearches, runSearch } from "./server/search";
import { clearTranscriptCaches } from "./server/transcripts";
import { listHistory, searchHistory } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(listHistory, () => buildCensus());
  server.handle(searchHistory, (input) => runSearch(input));
  return () => {
    abortAllSearches();
    clearCensusCaches();
    clearTranscriptCaches();
  };
}
