import { Select } from "@radix-ui/themes";

export interface PickOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** An empty value cannot be an item of the theme's Select, so "nothing chosen" travels under this name. */
const NONE = "__none__";

/**
 * A dropdown to choose one of a list. An option with the value "" means nothing is chosen ("not set"). Every dropdown of the app is
 * this one, so they all look and behave alike.
 */
export function Pick({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  size = "2",
  variant = "surface",
}: {
  value: string;
  options: readonly PickOption[];
  onChange: (value: string) => void;
  /** What the dropdown is for, for people who cannot see it. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  size?: "1" | "2" | "3";
  variant?: "surface" | "classic" | "soft" | "ghost";
}) {
  return (
    <Select.Root value={value === "" ? NONE : value} onValueChange={(v) => onChange(v === NONE ? "" : v)} size={size} {...(disabled !== undefined ? { disabled } : {})}>
      <Select.Trigger aria-label={label} variant={variant} {...(placeholder !== undefined ? { placeholder } : {})} />
      <Select.Content position="popper">
        {options.map((o) => (
          <Select.Item key={o.value === "" ? NONE : o.value} value={o.value === "" ? NONE : o.value} disabled={o.disabled}>
            {o.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
