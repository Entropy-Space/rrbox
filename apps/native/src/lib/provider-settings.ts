import type {
  ProviderRuntimeConfiguration,
  ProviderSettingsAdapter,
} from "@researchbox/provider-settings";
import { publicProviderRuntimeConfiguration } from "@researchbox/provider-settings";
import {
  invokeNativeProviderSettingsList,
  invokeNativeProviderSettingsRemove,
  invokeNativeProviderSettingsSave,
  invokeNativeProviderSettingsTest,
} from "./tauri.ts";

export const nativeProviderSettingsAdapter: ProviderSettingsAdapter = {
  load: invokeNativeProviderSettingsList,
  save: invokeNativeProviderSettingsSave,
  remove: invokeNativeProviderSettingsRemove,
  test: invokeNativeProviderSettingsTest,
};

export async function loadNativeProviderRuntimeConfigurations(): Promise<
  ProviderRuntimeConfiguration[]
> {
  const snapshot = await invokeNativeProviderSettingsList();
  return snapshot.providers
    .filter((provider) => provider.enabled)
    .map(publicProviderRuntimeConfiguration);
}
