import type { PluginServerContext } from "@getpaseo/plugin/server";
import { buildCensus, clearCensusCaches } from "./server/census";
import { getIndexStatus, requestSync, stopIndexer } from "./server/indexer";
import { abortAllSearches, runSearch } from "./server/search";
import { clearTranscriptCaches } from "./server/transcripts";
import { indexStatus, listHistory, restoreAgent, searchHistory } from "./shared/contracts";
import { restoreArchivedAgent } from "./server/restore-agent";

export default function contribute(server: PluginServerContext) {
  server.handle(restoreAgent, async ({ agentId }, { paseo }) => {
    await restoreArchivedAgent(agentId, paseo);
    return { agentId };
  });
  server.handle(listHistory, async () => {
    const census = await buildCensus();
    // The surface asked for the census, so it is open: bring the search index up to date.
    requestSync("census");
    return census;
  });
  server.handle(searchHistory, (input) => runSearch(input));
  server.handle(indexStatus, () => getIndexStatus());
  return async () => {
    abortAllSearches();
    await stopIndexer();
    clearCensusCaches();
    clearTranscriptCaches();
  };
}
