import { desktopPrefix, type EditorSettings } from "./editor";

export type ClientLayout = {
  compact: boolean;
  platform: "ios" | "android" | "web";
};

/** Keep path separators readable while escaping spaces and URI metacharacters. */
export function encodeRemotePath(directory: string): string {
  const path = /^[a-zA-Z]:[\\/]/.test(directory)
    ? `/${directory[0]!.toLowerCase()}:${directory.slice(2).replace(/\\/g, "/")}`
    : directory;
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return absolute
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
}

/** SSH aliases may contain user and port markers, which VS Code accepts literally. */
export function encodeRemoteHost(hostName: string): string {
  return encodeURIComponent(hostName.trim())
    .replace(/%40/gi, "@")
    .replace(/%3A/gi, ":");
}

export function desktopRemoteUrl(
  settings: EditorSettings,
  hostName: string,
  directory: string,
): string {
  return `${desktopPrefix(settings)}${encodeRemoteHost(hostName)}${encodeRemotePath(directory)}`;
}

/** vscode.dev reaches remote files through a VS Code tunnel, not through SSH. */
export function mobileRemoteUrl(hostName: string, directory: string): string {
  return `https://vscode.dev/tunnel/${encodeURIComponent(hostName.trim())}${encodeRemotePath(directory)}`;
}

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function isMobileLayout(layout: ClientLayout): boolean {
  if (layout.platform === "ios" || layout.platform === "android") return true;
  return layout.platform === "web" && isMobileBrowser();
}

export function remoteEditorUrl(input: {
  settings: EditorSettings;
  hostName: string;
  directory: string;
  mobile: boolean;
}): string {
  return input.mobile
    ? mobileRemoteUrl(input.hostName, input.directory)
    : desktopRemoteUrl(input.settings, input.hostName, input.directory);
}
