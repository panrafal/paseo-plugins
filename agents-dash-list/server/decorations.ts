import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  LabelDefinitionSchema,
  type DecorationProjectInput,
  type LabelDefinition,
  type getDecorations,
} from "../shared/contracts";
import { paseoHome } from "./paseo-home";

/**
 * Project icons and the workspace-label catalog live in `$PASEO_HOME` on the daemon machine and
 * are not exposed over the plugin SDK. This module reads them the same way the daemon does, so a
 * dash row shows exactly the icon and the chip colors the built-in sidebar shows.
 */

/** Icon file names in priority order; `*` is a glob over one file name. */
const ICON_PATTERNS = [
  "favicon.svg",
  "favicon.png",
  "favicon-*.svg",
  "favicon-*.png",
  "favico.svg",
  "favico.png",
  "icon.svg",
  "icon.png",
  "app-icon.svg",
  "app-icon.png",
  "apple-touch-icon.png",
  "apple-touch-icon-*.png",
  "icon-*.png",
  "android-chrome-*.png",
  "safari-pinned-tab.svg",
  "mstile-*.png",
  "logo.svg",
  "logo.png",
  "favicon.ico",
  "favico.ico",
] as const;

const GLOB_PATTERNS = new Map<string, RegExp>(
  ICON_PATTERNS.filter((pattern) => pattern.includes("*")).map((pattern) => [
    pattern,
    new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`),
  ]),
);

/** Directories searched before the project root, in priority order. */
const PRIORITY_DIRS = ["public", "static", "priv/static", "assets", "images", "img"] as const;
const MONOREPO_PACKAGE_DIRS = ["packages", "apps"] as const;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  "vendor",
  "src",
  "lib",
  "test",
  "tests",
  "__tests__",
]);

/** Levels searched below a priority directory. */
const PRIORITY_DIR_DEPTH = 2;
const MAX_DISCOVERED_ICON_BYTES = 32 * 1024;
const MAX_CUSTOM_ICON_BYTES = 512 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_LIMIT = 500;
/** Directory walks are IO heavy; a burst of projects must not saturate the daemon machine. */
const DISCOVERY_CONCURRENCY = 4;

interface IconCacheEntry {
  uri: string | null;
  expiresAt: number;
}

/** Insertion-ordered, so the first key is the least recently used one. */
const iconCache = new Map<string, IconCacheEntry>();

/** Drops every memoized icon; the plugin entry calls this when the runtime unloads. */
export function clearDecorationCache(): void {
  iconCache.clear();
}

export async function readDecorations(
  input: RpcInput<typeof getDecorations>,
): Promise<RpcOutput<typeof getDecorations>> {
  const [labels, icons] = await Promise.all([
    readLabelCatalog(),
    resolveIcons(input.projects),
  ]);
  return { icons, labels };
}

/**
 * Reads the daemon's label catalog. A label the plugin cannot understand is skipped rather than
 * failing the whole call: the chip then renders in the neutral fallback style.
 */
async function readLabelCatalog(): Promise<LabelDefinition[]> {
  const catalogPath = join(paseoHome(), "projects", "workspace-labels.json");
  let contents: string;
  try {
    contents = await readFile(catalogPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[agents-dash-list] could not read the label catalog at ${catalogPath}`);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parse error quotes the file, so only the location is reported.
    console.warn(`[agents-dash-list] ignoring unparsable label catalog at ${catalogPath}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[agents-dash-list] ignoring label catalog that is not an array at ${catalogPath}`);
    return [];
  }
  const labels: LabelDefinition[] = [];
  for (const entry of parsed) {
    const label = LabelDefinitionSchema.safeParse(entry);
    if (label.success) labels.push(label.data);
  }
  return labels;
}

async function resolveIcons(
  projects: readonly DecorationProjectInput[],
): Promise<Record<string, string | null>> {
  const unique = new Map<string, DecorationProjectInput>();
  for (const project of projects) {
    if (!unique.has(project.projectId)) unique.set(project.projectId, project);
  }
  const pending = [...unique.values()];
  const icons: Record<string, string | null> = {};
  await mapWithConcurrency(pending, DISCOVERY_CONCURRENCY, async (project) => {
    icons[project.projectId] = await resolveProjectIcon(project);
  });
  return icons;
}

async function mapWithConcurrency<Item>(
  items: readonly Item[],
  limit: number,
  run: (item: Item) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          const item = items[index];
          if (index >= items.length || item === undefined) return;
          await run(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function cacheKey(project: DecorationProjectInput): string {
  return `${project.projectId}|${project.customIconRevision ?? "auto"}|${project.rootPath}`;
}

async function resolveProjectIcon(project: DecorationProjectInput): Promise<string | null> {
  const key = cacheKey(project);
  const cached = iconCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh the recency of a hit so the cap evicts genuinely cold projects.
    iconCache.delete(key);
    iconCache.set(key, cached);
    return cached.uri;
  }
  iconCache.delete(key);
  let uri: string | null = null;
  try {
    uri = project.customIconRevision
      ? await readCustomIcon(project.projectId)
      : await discoverProjectIcon(project.rootPath);
  } catch (error) {
    // One unreadable project must never fail the whole dashboard.
    console.warn(`[agents-dash-list] could not resolve an icon for project ${project.projectId}`, error);
    uri = null;
  }
  iconCache.set(key, { uri, expiresAt: Date.now() + CACHE_TTL_MS });
  while (iconCache.size > CACHE_LIMIT) {
    const oldest = iconCache.keys().next();
    if (oldest.done) break;
    iconCache.delete(oldest.value);
  }
  return uri;
}

/** Icon bytes the user uploaded in Paseo, stored under a hash of the project ID. */
async function readCustomIcon(projectId: string): Promise<string | null> {
  const key = createHash("sha256").update(projectId).digest("hex");
  const iconPath = join(paseoHome(), "projects", "icons", `${key}.bin`);
  const bytes = await readIconFile(iconPath, MAX_CUSTOM_ICON_BYTES);
  return bytes ? toIconDataUri(bytes, null) : null;
}

async function discoverProjectIcon(rootPath: string): Promise<string | null> {
  // A relative root would resolve against the daemon's working directory.
  if (!isAbsolute(rootPath)) return null;
  const iconPath = await findProjectIcon(rootPath);
  if (!iconPath) return null;
  const bytes = await readIconFile(iconPath, MAX_DISCOVERED_ICON_BYTES);
  return bytes ? toIconDataUri(bytes, iconPath) : null;
}

async function readIconFile(iconPath: string, maxBytes: number): Promise<Buffer | null> {
  let size: number;
  try {
    const stats = await stat(iconPath);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }
  if (size === 0 || size > maxBytes) return null;
  try {
    return await readFile(iconPath);
  } catch {
    return null;
  }
}

/**
 * Mirrors the daemon's `findProjectIcon`: priority directories under the root, then every direct
 * child of `packages/` and `apps/`, then the root itself.
 */
async function findProjectIcon(rootPath: string): Promise<string | null> {
  const priority = await searchPriorityDirs(rootPath);
  if (priority) return priority;
  for (const monorepoDir of MONOREPO_PACKAGE_DIRS) {
    const monorepoPath = join(rootPath, monorepoDir);
    for (const entry of await listDirectory(monorepoPath)) {
      const packagePath = join(monorepoPath, entry);
      if (!(await isDirectory(packagePath))) continue;
      const found =
        (await searchPriorityDirs(packagePath)) ?? (await findIconInDirectory(packagePath));
      if (found) return found;
    }
  }
  return findIconInDirectory(rootPath);
}

async function searchPriorityDirs(basePath: string): Promise<string | null> {
  for (const priorityDir of PRIORITY_DIRS) {
    const priorityPath = join(basePath, priorityDir);
    if (!(await isDirectory(priorityPath))) continue;
    const found = await searchDirectory(priorityPath, PRIORITY_DIR_DEPTH, 0);
    if (found) return found;
  }
  return null;
}

async function searchDirectory(
  directory: string,
  maxDepth: number,
  depth: number,
): Promise<string | null> {
  if (depth > maxDepth) return null;
  const found = await findIconInDirectory(directory);
  if (found) return found;
  for (const entry of await listDirectory(directory)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const child = join(directory, entry);
    if (!(await isDirectory(child))) continue;
    const nested = await searchDirectory(child, maxDepth, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function findIconInDirectory(directory: string): Promise<string | null> {
  const entries = await listDirectory(directory);
  if (entries.length === 0) return null;
  for (const pattern of ICON_PATTERNS) {
    for (const entry of entries) {
      if (!matchesPattern(entry, pattern)) continue;
      const candidate = join(directory, entry);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

function matchesPattern(fileName: string, pattern: string): boolean {
  const glob = GLOB_PATTERNS.get(pattern);
  return glob ? glob.test(fileName) : fileName === pattern;
}

async function listDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Turns icon bytes into the `data:` URI the client renders. Extensions lie, so the type comes
 * from the magic bytes; only SVG, which has no reliable signature, falls back to the extension.
 */
function toIconDataUri(bytes: Buffer, iconPath: string | null): string | null {
  let mimeType = sniffMimeType(bytes) ?? (iconPath ? svgMimeType(iconPath) : null);
  if (!mimeType) return null;
  let payload = bytes;
  if (mimeType === "image/x-icon") {
    // React Native cannot decode an ICO container, but modern favicons carry a PNG frame.
    const frame = extractIcoPngFrame(bytes);
    if (frame) {
      payload = frame;
      mimeType = "image/png";
    }
  }
  // Icons render in a small square; a banner-shaped logo would be distorted.
  if (!isSquareImage(payload, mimeType)) return null;
  return `data:${mimeType};base64,${payload.toString("base64")}`;
}

function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes.readUInt16LE(0) === 0 &&
    bytes.readUInt16LE(2) === 1 &&
    bytes.readUInt16LE(4) > 0
  ) {
    return "image/x-icon";
  }
  return null;
}

function svgMimeType(iconPath: string): string | null {
  return extname(iconPath).toLowerCase() === ".svg" ? "image/svg+xml" : null;
}

/** Largest PNG-encoded frame inside an ICO container, or null when it has none. */
function extractIcoPngFrame(bytes: Buffer): Buffer | null {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const frameCount = bytes.readUInt16LE(4);
  let best: Buffer | null = null;
  let bestWidth = -1;
  for (let index = 0; index < frameCount; index += 1) {
    // Directory entry: width(1) height(1) colors(1) reserved(1) planes(2) bpp(2)
    // dataSize(4 LE) dataOffset(4 LE). A width byte of 0 means 256.
    const entryOffset = 6 + index * 16;
    if (entryOffset + 16 > bytes.length) break;
    const width = bytes[entryOffset] === 0 ? 256 : (bytes[entryOffset] ?? 0);
    const dataSize = bytes.readUInt32LE(entryOffset + 8);
    const dataOffset = bytes.readUInt32LE(entryOffset + 12);
    if (dataOffset + dataSize > bytes.length) continue;
    const frame = bytes.subarray(dataOffset, dataOffset + dataSize);
    if (frame.length >= 8 && frame.subarray(0, 8).equals(PNG_SIGNATURE) && width > bestWidth) {
      best = frame;
      bestWidth = width;
    }
  }
  return best;
}

interface ImageDimensions {
  width: number;
  height: number;
}

function isSquareImage(bytes: Buffer, mimeType: string): boolean {
  // SVG and ICO carry no single reliable size; icons in those formats are square by convention.
  if (mimeType === "image/svg+xml" || mimeType === "image/x-icon") return true;
  const dimensions = imageDimensions(bytes, mimeType);
  return dimensions !== null && dimensions.width > 0 && dimensions.width === dimensions.height;
}

function imageDimensions(bytes: Buffer, mimeType: string): ImageDimensions | null {
  switch (mimeType) {
    case "image/png":
      return pngDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
    default:
      return null;
  }
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function gifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const chunkType = bytes.toString("ascii", 12, 16);
  if (chunkType === "VP8 ") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
