import { Platform } from "react-native";

declare const document: { createElement(tag: "a"): { href: string; download: string; click(): void } } | undefined;
declare const Blob: { new(parts: string[], options: { type: string }): unknown };
declare const URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };

export function downloadCsv(csv: string): boolean {
  if (Platform.OS !== "web" || typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") return false;
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "session-usage.csv";
  link.click();
  // Let the browser consume the URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
