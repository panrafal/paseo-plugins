import type { PluginTheme } from "@getpaseo/plugin";
import type { RunStatus } from "./contracts";

/**
 * `PluginTheme` has no scheme flag and no "running" blue, so darkness is read off the surface
 * color it does supply and the running color is taken from the app's palette per scheme.
 */

export type ColorScheme = "light" | "dark";

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1] ?? "";
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((character) => character + character)
      .join("");
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function relativeLuminance(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function themeScheme(theme: PluginTheme): ColorScheme {
  const luminance = relativeLuminance(theme.colors.surface0);
  if (luminance === null) return "dark";
  return luminance < 0.4 ? "dark" : "light";
}

const STATUS_RUNNING = { light: "#268ae0", dark: "#5caaf6" } as const;
const STATUS_MERGED = { light: "#7347af", dark: "#a890d5" } as const;

export function runningColor(scheme: ColorScheme): string {
  return STATUS_RUNNING[scheme];
}

export function mergedColor(scheme: ColorScheme): string {
  return STATUS_MERGED[scheme];
}

export function runStatusColor(status: RunStatus, theme: PluginTheme, scheme: ColorScheme): string {
  switch (status) {
    case "running":
      return runningColor(scheme);
    case "succeeded":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
  }
}
