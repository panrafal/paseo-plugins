import { Linking } from "react-native";

/**
 * On the desktop renderer `Linking.openURL` opens a bare child browser frame instead of the
 * user's browser. The desktop preload exposes the opener Paseo's own links use; it accepts
 * HTTP(S) only, which is all a pull request URL ever is. Mobile and plain web keep `Linking`.
 */
interface DesktopOpenerBridge {
  readonly opener?: { readonly openUrl?: (url: string) => Promise<void> };
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const openUrl = (globalThis as { paseoDesktop?: DesktopOpenerBridge }).paseoDesktop?.opener
    ?.openUrl;
  if (isHttpUrl(url) && typeof openUrl === "function") {
    try {
      await openUrl(url);
      return;
    } catch (error) {
      console.warn("[schedule-runs] desktop opener refused the URL, falling back", error);
    }
  }
  await Linking.openURL(url);
}
