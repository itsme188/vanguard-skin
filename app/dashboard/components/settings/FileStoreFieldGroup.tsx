"use client";

/**
 * The controls for one group's `AppSettings` fields.
 *
 * Every field reads its label and its one-line explanation from
 * `settings-fields.ts`, so the copy and the control can never drift apart. A
 * secret shows as `***` plus the last four characters of what is stored — the
 * real value never leaves the settings file — and typing replaces it whole.
 *
 * Nothing here saves: the dirty map and the single Save live in
 * SettingsStoreProvider, so one Save covers every group on the page.
 */

import { useState } from "react";
import { fieldsInGroup, type SettingsField, type SettingsGroupId } from "./settings-fields";
import { useSettingsStore } from "./SettingsStoreProvider";

export function FileStoreFieldGroup({ group }: { group: SettingsGroupId }) {
  const { values, dirty, setField, unavailableReason } = useSettingsStore();
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const fields = fieldsInGroup(group);

  if (unavailableReason || fields.length === 0) return null;

  return (
    <div className="px-5 py-4 space-y-4 border-b border-edge last:border-b-0">
      {/* When a change here takes effect. These values are handed to the
          server as environment variables while the app starts, so the running
          app keeps the old ones until it is restarted. The note sits with the
          fields so it never shows over an empty group. */}
      <p className="text-[12px] text-ink-dim">
        <span className="font-medium text-ink">Takes effect after a restart.</span> These are kept
        in the app&apos;s own settings file and read once, when the app starts.
      </p>
      {fields.map((field) => (
        <FieldRow
          key={field.key}
          field={field}
          stored={values[field.key]}
          draft={field.key in dirty ? dirty[field.key] : null}
          onChange={(v) => setField(field.key, v)}
          visible={!!shown[field.key]}
          onToggleVisible={() =>
            setShown((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
          }
        />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  stored,
  draft,
  onChange,
  visible,
  onToggleVisible,
}: {
  field: SettingsField;
  stored: string | number | boolean | undefined;
  /** The owner's unsaved text, or null when nothing has been typed. */
  draft: string | null;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
}) {
  const isDirty = draft !== null;
  const helpId = `settings-help-${field.key}`;
  const labelClass = `block text-[13px] font-medium ${isDirty ? "text-gold-ink" : "text-ink"}`;

  if (field.kind === "toggle") {
    const checked = isDirty ? draft === "true" : !!stored;
    return (
      <div className="space-y-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(String(e.target.checked))}
            aria-describedby={helpId}
            className="accent-gold w-4 h-4"
          />
          <span className={`text-[13px] font-medium ${isDirty ? "text-gold-ink" : "text-ink"}`}>
            {field.label}
          </span>
        </label>
        <p id={helpId} className="text-[12px] text-ink-dim max-w-2xl">
          {field.help}
        </p>
      </div>
    );
  }

  if (field.kind === "select") {
    const current = isDirty ? draft : String(stored ?? "");
    return (
      <div className="space-y-1">
        <label htmlFor={field.key} className={labelClass}>
          {field.label}
        </label>
        <p id={helpId} className="text-[12px] text-ink-dim max-w-2xl">
          {field.help}
        </p>
        <select
          id={field.key}
          value={current}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={helpId}
          className={`w-full max-w-md px-2 py-1.5 text-[13px] bg-raised border rounded text-ink ${
            isDirty ? "border-gold/50" : "border-edge"
          }`}
        >
          {/* A value the store holds that is not one of the listed options
              (an older or hand-edited settings file) stays visible rather
              than silently snapping to the first option. */}
          {!(field.options ?? []).some((o) => o.value === current) && (
            <option value={current}>{current === "" ? "Not set" : current}</option>
          )}
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const text = isDirty ? draft : stored === undefined || stored === "" ? "" : String(stored);

  return (
    <div className="space-y-1">
      <label htmlFor={field.key} className={labelClass}>
        {field.label}
      </label>
      <p id={helpId} className="text-[12px] text-ink-dim max-w-2xl">
        {field.help}
      </p>
      <div className="relative max-w-md">
        <input
          id={field.key}
          type={field.sensitive && !visible ? "password" : "text"}
          inputMode={field.kind === "number" ? "numeric" : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.sensitive ? "Enter a new value to replace it…" : ""}
          aria-describedby={helpId}
          className={`w-full px-2 py-1.5 pr-14 text-[13px] font-mono bg-raised border rounded text-ink ${
            isDirty ? "border-gold/50" : "border-edge"
          }`}
        />
        {field.sensitive && (
          <button
            type="button"
            onClick={onToggleVisible}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-ink-dim hover:text-ink underline"
            aria-label={visible ? `Hide ${field.label}` : `Show ${field.label}`}
          >
            {visible ? "hide" : "show"}
          </button>
        )}
      </div>
      {field.sensitive && !isDirty && typeof stored === "string" && stored.startsWith("***") && (
        <p className="text-[11px] text-ink-faint">
          A value is stored. Only its last characters are shown; typing replaces it.
        </p>
      )}
    </div>
  );
}
