export const PROVIDER_SETTINGS_TABS = [
  { id: "tokn", label: "Tokn" },
  { id: "openai_compatible", label: "OpenAI-compatible" },
] as const;

export type ProviderSettingsTab = typeof PROVIDER_SETTINGS_TABS[number]["id"];

/** Automatic activation is safe because both local settings panels stay mounted. */
export function providerSettingsTabForKey(
  current: ProviderSettingsTab,
  key: string,
): ProviderSettingsTab | null {
  const tabs = PROVIDER_SETTINGS_TABS;
  const index = tabs.findIndex((tab) => tab.id === current);
  switch (key) {
    case "ArrowLeft": return tabs[(index + tabs.length - 1) % tabs.length].id;
    case "ArrowRight": return tabs[(index + 1) % tabs.length].id;
    case "Home": return tabs[0].id;
    case "End": return tabs[tabs.length - 1].id;
    default: return null;
  }
}
