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
  invokeNativeToknConnect, invokeNativeToknSettingsSave, invokeNativeToknSettingsValidate, invokeNativeToknReload,
} from "./tauri.ts";

export const nativeProviderSettingsAdapter: ProviderSettingsAdapter = {
  tokn: { connect: invokeNativeToknConnect, save: invokeNativeToknSettingsSave, validate: invokeNativeToknSettingsValidate, reload: invokeNativeToknReload },
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
