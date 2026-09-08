import { Platform } from "react-native";

interface DesktopOpenerBridge {
  readonly opener?: { readonly openUrl?: (url: string) => Promise<void> };
}

export async function openDesktopUrl(url: string): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  const openUrl = (globalThis as { paseoDesktop?: DesktopOpenerBridge }).paseoDesktop?.opener?.openUrl;
  if (!openUrl) return false;
  try {
    await openUrl(url);
    return true;
  } catch (error) {
    console.warn("[task-link] desktop opener refused the URL, falling back", error);
    return false;
  }
}
