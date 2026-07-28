"use client";

import { Check, Puzzle, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  resolvePluginSetting,
  type PluginCatalogEntry,
  type PluginSetting,
  type PluginSettingsDocument,
} from "./plugin-settings.ts";

export function PluginsPage({
  plugins,
  settings,
  is_disabled,
  on_close,
  on_save,
}: {
  plugins: readonly PluginCatalogEntry[];
  settings: PluginSettingsDocument;
  is_disabled: boolean;
  on_close(): void;
  on_save(plugin_id: string, setting: PluginSetting): string | null;
}) {
  return (
    <section className="plugins-page" aria-labelledby="plugins-page-title">
      <header className="plugins-page-header">
        <div>
          <span className="plugins-page-eyebrow">Agent capabilities</span>
          <h1 id="plugins-page-title">Plugins</h1>
          <p>
            Enable optional tools and choose the limits they use. Changes
            restart the local agent core without changing your projects.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close plugins"
          onClick={on_close}
        >
          <X size={19} />
        </button>
      </header>

      <div className="plugin-grid">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.plugin_id}
            plugin={plugin}
            persisted={resolvePluginSetting(settings, plugin)}
            is_disabled={is_disabled}
            on_save={on_save}
          />
        ))}
      </div>
    </section>
  );
}

function PluginCard({
  plugin,
  persisted,
  is_disabled,
  on_save,
}: {
  plugin: PluginCatalogEntry;
  persisted: PluginSetting;
  is_disabled: boolean;
  on_save(plugin_id: string, setting: PluginSetting): string | null;
}) {
  const [draft, setDraft] = useState(persisted);
  const [notice, setNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const validationError = useMemo(
    () => validatePluginSetting(plugin, draft),
    [draft, plugin],
  );
  const isDirty =
    draft.enabled !== persisted.enabled ||
    plugin.configuration_fields.some(
      (field) =>
        draft.configuration[field.configuration_key] !==
        persisted.configuration[field.configuration_key],
    );

  function save() {
    if (validationError) return;
    const error = on_save(plugin.plugin_id, draft);
    setNotice(
      error
        ? { kind: "error", message: error }
        : {
            kind: "success",
            message: `${plugin.display_name} settings saved.`,
          },
    );
  }

  return (
    <article className="plugin-card">
      <div className="plugin-card-heading">
        <span className="plugin-icon" aria-hidden={true}>
          <Puzzle size={21} />
        </span>
        <div>
          <div className="plugin-title-line">
            <h2>{plugin.display_name}</h2>
            <span
              className={`plugin-state ${persisted.enabled ? "enabled" : ""}`}
            >
              {persisted.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <p>{plugin.description}</p>
        </div>
      </div>

      <label className="plugin-toggle">
        <span>
          <strong>Enable plugin</strong>
          <small>Add its tools to new agent runs.</small>
        </span>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={is_disabled}
          onChange={(event) => {
            setDraft((current) => ({
              ...current,
              enabled: event.target.checked,
            }));
            setNotice(null);
          }}
        />
      </label>

      <div className="plugin-fields">
        {plugin.configuration_fields.map((field) => {
          const updateValue = (value: string | number) => {
            setDraft((current) => ({
              ...current,
              configuration: {
                ...current.configuration,
                [field.configuration_key]: value,
              },
            }));
            setNotice(null);
          };
          return (
            <label key={field.configuration_key} className="plugin-field">
              <span>
                <strong>{field.display_name}</strong>
                <small>{field.description}</small>
              </span>
              {field.kind === "number"
                ? (
                    <span className="plugin-number-input">
                      <input
                        type="number"
                        min={field.minimum}
                        max={field.maximum}
                        step={field.step}
                        value={String(
                          draft.configuration[
                            field.configuration_key
                          ] ?? field.default_value,
                        )}
                        disabled={is_disabled}
                        aria-invalid={validationError !== null}
                        onChange={(event) =>
                          updateValue(event.target.valueAsNumber)}
                      />
                      {field.suffix && <span>{field.suffix}</span>}
                    </span>
                  )
                : (
                    <select
                      value={String(
                        draft.configuration[field.configuration_key] ??
                          field.default_value,
                      )}
                      disabled={is_disabled}
                      aria-invalid={validationError !== null}
                      onChange={(event) =>
                        updateValue(event.target.value)}
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.display_name}
                        </option>
                      ))}
                    </select>
                  )}
            </label>
          );
        })}
      </div>

      <footer className="plugin-card-footer">
        <span
          className={
            notice?.kind === "error" || validationError
              ? "plugin-notice error"
              : "plugin-notice"
          }
          role={notice?.kind === "error" ? "alert" : "status"}
        >
          {validationError ??
            notice?.message ??
            (is_disabled
              ? "Finish the active operation before changing plugins."
              : "")}
        </span>
        <button
          className="primary"
          type="button"
          disabled={is_disabled || !isDirty || validationError !== null}
          onClick={save}
        >
          <Check size={16} />
          Save changes
        </button>
      </footer>
    </article>
  );
}

function validatePluginSetting(
  plugin: PluginCatalogEntry,
  setting: PluginSetting,
): string | null {
  for (const field of plugin.configuration_fields) {
    const value = setting.configuration[field.configuration_key];
    if (field.kind === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < field.minimum ||
        value > field.maximum ||
        !Number.isInteger((value - field.minimum) / field.step)
      ) {
        return `${field.display_name} must be between ${field.minimum} and ${field.maximum}.`;
      }
    } else if (
      typeof value !== "string" ||
      !field.options.some((option) => option.value === value)
    ) {
      return `${field.display_name} has an invalid selection.`;
    }
  }
  return null;
}
