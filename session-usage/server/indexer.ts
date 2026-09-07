import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { paseoHome } from "./paseo-home";
import { object, string, parseTranscript, type ParsedTranscript } from "./parser";
import type { Session, Snapshot } from "../shared/schema";

interface Source {
  path: string;
  provider: "claude" | "codex";
  nativeId: string;
  parentId: string | null;
  kind: "main" | "subagent";
  archived: boolean;
  size: number;
  mtimeMs: number;
}
interface Metadata {
  agents: Map<string, Agent>;
  workspaces: Map<string, Workspace>;
  projects: Map<string, Project>;
}
interface Agent { id: string; nativeId: string; provider: string; workspaceId: string; cwd: string; title: string; archived: boolean; status: string; createdAt: string; model: string }
interface Workspace { id: string; projectId: string; cwd: string; title: string; branch: string; labels: string[]; archived: boolean }
interface Project { id: string; root: string; name: string; archived: boolean }
export interface Roots { paseo: string; claude: string; codex: string }

async function entries(path: string, warnings: Set<string>) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) warnings.add(`Cannot read directory: ${path}`);
    return [];
  }
}
async function json(path: string, warnings: Set<string>): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.add(`Cannot read metadata: ${basename(path)}`);
    return null;
  }
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export async function readMetadata(root: string, warnings: Set<string>): Promise<Metadata> {
  const metadata: Metadata = { agents: new Map(), workspaces: new Map(), projects: new Map() };
  const [projects, workspaces] = await Promise.all([json(join(root, "projects", "projects.json"), warnings), json(join(root, "projects", "workspaces.json"), warnings)]);
  for (const raw of array(projects)) {
    const p = object(raw);
    const id = string(p.projectId);
    if (id) metadata.projects.set(id, { id, root: string(p.rootPath), name: string(p.customName) || string(p.displayName) || basename(string(p.rootPath)), archived: Boolean(p.archivedAt) });
  }
  for (const raw of array(workspaces)) {
    const w = object(raw);
    const id = string(w.workspaceId);
    if (id) metadata.workspaces.set(id, { id, cwd: string(w.cwd), projectId: string(w.projectId), title: string(w.title) || string(w.displayName) || basename(string(w.cwd)), branch: string(w.branch), labels: array(w.labels).filter((label): label is string => typeof label === "string"), archived: Boolean(w.archivedAt) });
  }
  const directories = await entries(join(root, "agents"), warnings);
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const path = join(root, "agents", directory.name);
    for (const file of await entries(path, warnings)) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const a = object(await json(join(path, file.name), warnings));
      if (a.provider !== "claude" && a.provider !== "codex") continue;
      // Explicit allowlist: persistence.metadata contains credentials and is never retained.
      const p = object(a.persistence);
      const nativeId = a.provider === "claude" ? string(p.sessionId) || string(p.nativeHandle) : string(p.nativeHandle) || string(p.sessionId);
      const id = string(a.id);
      if (!id) continue;
      const key = `${a.provider}:${nativeId || `missing:${id}`}`;
      const value: Agent = { id, nativeId, provider: a.provider, cwd: string(a.cwd), workspaceId: string(a.workspaceId), title: string(a.title), archived: Boolean(a.archivedAt), status: string(a.lastStatus) || "unknown", createdAt: string(a.createdAt), model: string(object(a.runtimeInfo).model) || string(object(a.config).model) };
      // Resuming the same provider session in multiple Paseo records must not multiply usage.
      const previous = metadata.agents.get(key);
      if (!previous || (previous.archived && !value.archived) || (previous.archived === value.archived && value.createdAt > previous.createdAt)) metadata.agents.set(key, value);
    }
  }
  return metadata;
}

async function discover(roots: Roots, warnings: Set<string>, signal: AbortSignal): Promise<Source[]> {
  const sources = new Map<string, Source>();
  for (const [root, provider, archived] of [[join(roots.claude, "projects"), "claude", false], [join(roots.codex, "sessions"), "codex", false], [join(roots.codex, "archived_sessions"), "codex", true]] as const) {
    const queue = [root];
    while (queue.length) {
      if (signal.aborted) throw new Error("Scan cancelled");
      const directory = queue.pop()!;
      for (const entry of await entries(directory, warnings)) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { queue.push(path); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        let nativeId: string;
        let parentId: string | null = null;
        if (provider === "codex") {
          const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(entry.name);
          if (!match) continue;
          nativeId = match[1];
        } else {
          nativeId = entry.name.slice(0, -6);
          const segments = path.split(sep);
          const subagentIndex = segments.lastIndexOf("subagents");
          if (subagentIndex >= 1) parentId = segments[subagentIndex - 1];
          if (parentId) nativeId = `${parentId}/${nativeId}`;
        }
        try {
          const info = await stat(path);
          const source: Source = { path, nativeId, provider, archived, parentId, kind: parentId ? "subagent" : "main", size: info.size, mtimeMs: info.mtimeMs };
          const key = `${provider}:${nativeId}`;
          const previous = sources.get(key);
          // A copied/moved rollout in both trees is one session. Prefer the fullest copy.
          if (!previous || previous.size < source.size || (previous.size === source.size && source.mtimeMs > previous.mtimeMs)) sources.set(key, source);
          if (previous?.archived) sources.get(key)!.archived = true;
          if (archived) sources.get(key)!.archived = true;
        } catch { warnings.add("A transcript disappeared or could not be inspected during the scan."); }
      }
    }
  }
  return [...sources.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function joinSession(source: Source, parsed: ParsedTranscript, metadata: Metadata): Session {
  const key = `${source.provider}:${source.nativeId}`;
  const agent = metadata.agents.get(key);
  const parentId = source.parentId ?? parsed.parentId;
  const parent = parentId ? metadata.agents.get(`${source.provider}:${parentId}`) : undefined;
  const owner = agent ?? parent;
  const cwd = parsed.cwd || owner?.cwd || "";
  const workspace = metadata.workspaces.get(owner?.workspaceId ?? "") ?? [...metadata.workspaces.values()].filter((w) => cwd && resolve(w.cwd) === resolve(cwd)).sort((a, b) => Number(a.archived) - Number(b.archived))[0];
  const project = metadata.projects.get(workspace?.projectId ?? "") ?? [...metadata.projects.values()].filter((p) => p.root && cwd && (resolve(cwd) === resolve(p.root) || resolve(cwd).startsWith(`${resolve(p.root)}${sep}`))).sort((a, b) => b.root.length - a.root.length)[0];
  return {
    id: key, nativeId: source.nativeId, provider: source.provider,
    kind: parentId || parsed.isSubagent ? "subagent" : source.kind, parentId: parentId ? `${source.provider}:${parentId}` : null,
    title: agent?.title || parsed.title || `${source.provider === "claude" ? "Claude" : "Codex"} ${source.nativeId.slice(-12)}`,
    agentId: agent?.id ?? null, workspaceId: workspace?.id ?? null, workspace: workspace?.title ?? "",
    projectId: project?.id ?? null, project: project?.name ?? "Outside Paseo / unknown project",
    cwd, branch: workspace?.branch || parsed.branch, labels: workspace?.labels ?? [],
    archived: source.archived || Boolean(owner?.archived || workspace?.archived || project?.archived),
    status: agent?.status ?? "untracked", startedAt: parsed.startedAt, endedAt: parsed.endedAt,
    bytes: source.size, coverage: parsed.warnings.length ? "partial" : "available", warnings: parsed.warnings, buckets: parsed.buckets,
  };
}

/** One background scan per installation, four streams at once, size/mtime cache in memory only. */
export class UsageIndex {
  private cache = new Map<string, { size: number; mtimeMs: number; parsed: ParsedTranscript }>();
  private state: Snapshot = { sessions: [], scanning: false, completed: 0, total: 0, generatedAt: null, warnings: [] };
  private controller = new AbortController();
  private running: Promise<void> | null = null;
  private lastScan = 0;
  constructor(private roots: Roots = { paseo: paseoHome(), claude: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), codex: process.env.CODEX_HOME ?? join(homedir(), ".codex") }) {}

  snapshot(refresh = false): Snapshot {
    if (!this.controller.signal.aborted && !this.running && (refresh || !this.lastScan || Date.now() - this.lastScan > 30_000)) {
      this.state = { ...this.state, scanning: true, completed: 0, total: 0 };
      this.running = this.scan().catch(() => {
        if (!this.controller.signal.aborted) this.state = { ...this.state, warnings: ["Session scan failed. Refresh to retry."], scanning: false };
      }).finally(() => { this.running = null; this.lastScan = Date.now(); });
    }
    return this.state;
  }
  async settled(): Promise<Snapshot> { await this.running; return this.state; }
  dispose(): void { this.controller.abort(); this.cache.clear(); this.state.sessions = []; }

  private async scan(): Promise<void> {
    const warnings = new Set<string>();
    const [metadata, sources] = await Promise.all([readMetadata(this.roots.paseo, warnings), discover(this.roots, warnings, this.controller.signal)]);
    this.state = { ...this.state, total: sources.length };
    const sessions: Session[] = [];
    let next = 0;
    const livePaths = new Set(sources.map((s) => s.path));
    const worker = async () => {
      while (next < sources.length) {
        if (this.controller.signal.aborted) throw new Error("Scan cancelled");
        const source = sources[next++];
        try {
          const cached = this.cache.get(source.path);
          const parsed = cached?.size === source.size && cached.mtimeMs === source.mtimeMs ? cached.parsed : await parseTranscript(source.path, source.provider, this.controller.signal);
          this.cache.set(source.path, { size: source.size, mtimeMs: source.mtimeMs, parsed });
          sessions.push(joinSession(source, parsed, metadata));
        } catch {
          if (this.controller.signal.aborted) return;
          const session = joinSession(source, { nativeId: source.nativeId, parentId: source.parentId, cwd: "", title: "", branch: "", startedAt: null, endedAt: null, buckets: [], warnings: ["Transcript could not be read."] }, metadata);
          session.coverage = "missing";
          sessions.push(session);
        }
        this.state = { ...this.state, completed: this.state.completed + 1 };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
    if (this.controller.signal.aborted) throw new Error("Scan cancelled");
    const seen = new Set(sessions.map((s) => s.id));
    for (const [key, agent] of metadata.agents) {
      if (seen.has(key)) continue;
      const source: Source = { nativeId: agent.nativeId || `missing:${agent.id}`, provider: agent.provider as "claude" | "codex", parentId: null, kind: "main", path: "", size: 0, mtimeMs: 0, archived: agent.archived };
      const session = joinSession(source, { nativeId: source.nativeId, parentId: null, cwd: agent.cwd, title: agent.title, branch: "", startedAt: agent.createdAt || null, endedAt: null, buckets: [], warnings: [agent.nativeId ? "Transcript is missing from the provider directories." : "Agent has no recorded provider session."] }, metadata);
      session.coverage = "missing";
      sessions.push(session);
    }
    for (const path of this.cache.keys()) if (!livePaths.has(path)) this.cache.delete(path);
    this.state = { sessions: sessions.sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "")), scanning: false, completed: sources.length, total: sources.length, generatedAt: new Date().toISOString(), warnings: [...warnings] };
  }
}
