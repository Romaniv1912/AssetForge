import { PROTOCOL_VERSION } from '../../shared/constants';

/**
 * Hosted UI (GitHub Pages).
 *
 * Figma loads the plugin UI into an opaque-origin, non-secure iframe: there is
 * no Cache Storage, no IndexedDB and no WebGPU, so the background-removal
 * model is downloaded again on every launch. The bundled UI therefore
 * navigates itself to an identical copy on GitHub Pages (Figma's "non-null
 * origin" UI), where downloads are cached and WebGPU is available.
 *
 * The switch only happens when the hosted copy answers quickly and speaks the
 * same protocol as the installed plugin; otherwise (offline, not deployed,
 * older/newer version) the bundled UI keeps running as before.
 */
const PROBE_TIMEOUT_MS = 2500;
const THEME_PARAM = 'figma-theme';

interface ForwardedTheme {
  className: string;
  vars: Record<string, string>;
}

/** True when this page was loaded from a URL (the hosted copy), not inlined by Figma. */
/** Why the bundled UI is running instead of the hosted copy (for the settings hint). */
let bundledReason = 'the hosted copy is disabled in this build';

export function hostedUiStatus(): { hosted: boolean; reason: string } {
  return isHosted() ? { hosted: true, reason: '' } : { hosted: false, reason: bundledReason };
}

export function isHosted(): boolean {
  return location.protocol === 'https:' || location.protocol === 'http:';
}

/** Resolves true when navigation to the hosted UI has started (do not render). */
export async function redirectToHostedUi(): Promise<boolean> {
  const base = __REMOTE_UI_URL__;
  if (!base || isHosted()) return false;
  if (!isFigma()) {
    bundledReason = 'not running inside Figma';
    return false;
  }
  const probe = new URL('version.json', base).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(probe, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      bundledReason = `${probe} returned HTTP ${response.status}`;
      return false;
    }
    const info = (await response.json()) as { protocol?: number };
    if (info.protocol !== PROTOCOL_VERSION) {
      bundledReason = `the hosted copy uses protocol ${String(info.protocol)}, this plugin ${PROTOCOL_VERSION} (update the plugin)`;
      return false;
    }
  } catch (error) {
    bundledReason = controller.signal.aborted
      ? `${probe} did not answer within ${PROBE_TIMEOUT_MS / 1000} s`
      : `${probe} is unreachable (${error instanceof Error ? error.message : String(error)})`;
    console.warn('[AssetForge] Hosted UI unavailable:', bundledReason);
    return false;
  } finally {
    clearTimeout(timer);
  }
  const url = new URL(base);
  url.hash = `${THEME_PARAM}=${encodeURIComponent(JSON.stringify(collectTheme()))}`;
  location.replace(url.href);
  return true;
}

/**
 * Figma injects its theme tokens (`--figma-color-*`) and the `figma-light` /
 * `figma-dark` class only into the bundled page, so they are forwarded in the
 * URL fragment and re-applied by the hosted copy.
 */
export function applyForwardedTheme(): void {
  const match = new RegExp(`${THEME_PARAM}=([^&]*)`).exec(location.hash);
  if (!match) return;
  try {
    const theme = JSON.parse(decodeURIComponent(match[1]!)) as ForwardedTheme;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(theme.vars)) {
      if (name.startsWith('--figma-')) root.style.setProperty(name, value);
    }
    for (const cls of theme.className.split(/\s+/)) if (/^figma-/.test(cls)) root.classList.add(cls);
  } catch {
    // Malformed fragment: the CSS fallbacks still give a usable theme.
  }
  history.replaceState(null, '', location.pathname + location.search);
}

/** Asks the browser not to evict cached models under storage pressure. */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => false);
}

function isFigma(): boolean {
  // Figma adds the theme class/tokens when the plugin enables themeColors.
  return /\bfigma-(light|dark)\b/.test(document.documentElement.className) || collectTheme().vars['--figma-color-bg'] !== undefined;
}

function collectTheme(): ForwardedTheme {
  // Token names come from Figma's injected rules (and inline style); values
  // are read resolved, so only the currently active theme is forwarded.
  const root = document.documentElement;
  const names = new Set<string>(Array.from(root.style).filter((n) => n.startsWith('--figma-')));
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet (Google Fonts)
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const name of Array.from(rule.style)) if (name.startsWith('--figma-')) names.add(name);
    }
  }
  const computed = getComputedStyle(root);
  const vars: Record<string, string> = {};
  for (const name of names) {
    const value = computed.getPropertyValue(name).trim();
    if (value) vars[name] = value;
  }
  return { className: root.className, vars };
}
