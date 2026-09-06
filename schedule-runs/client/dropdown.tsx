import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

/**
 * A filter selector: a trigger that reads like `Status: Succeeded` and opens a picker in the
 * host's modal. Multi-select pickers offer an "All" row that clears the selection; single-select
 * ones close as soon as a row is chosen. The modal is the host's own, so it renders the same on
 * web, desktop, and phones, where a floating popover would not fit anyway.
 */
export interface DropdownOption {
  id: string;
  label: string;
  icon?: string;
  iconColor?: string;
  count?: number;
}

export interface DropdownProps {
  label: string;
  /** Text on the trigger; `null` reads as "All". */
  summary: string | null;
  options: readonly DropdownOption[];
  selected: ReadonlySet<string>;
  multi: boolean;
  onToggle(id: string): void;
  /** Multi-select only: clears the selection. */
  onClear?(): void;
  theme: PluginTheme;
  icon?: string;
}

export function Dropdown({
  label,
  summary,
  options,
  selected,
  multi,
  onToggle,
  onClear,
  theme,
  icon,
}: DropdownProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // A single-select always has one row checked; only a narrowing choice counts as active.
  const active = summary !== null;
  const value = summary ?? "All";

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityHint={`Choose ${label.toLowerCase()}`}
        accessibilityState={{ expanded: open }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          active ? styles.triggerActive : null,
          hovered ? styles.triggerHovered : null,
          pressed ? styles.triggerPressed : null,
        ]}
      >
        {icon ? (
          <Icon
            name={icon}
            size={12}
            color={active ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        ) : null}
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text
          style={[styles.triggerValue, active ? styles.triggerValueActive : null]}
          numberOfLines={1}
        >
          {value}
        </Text>
        <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
      </Pressable>

      <Modal title={label} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {multi ? (
              <Row
                label="All"
                checked={!active}
                role="checkbox"
                onPress={() => {
                  onClear?.();
                }}
                theme={theme}
                styles={styles}
              />
            ) : null}
            {options.map((option) => (
              <Row
                key={option.id}
                label={option.label}
                icon={option.icon}
                iconColor={option.iconColor}
                count={option.count}
                checked={selected.has(option.id)}
                role={multi ? "checkbox" : "radio"}
                onPress={() => {
                  onToggle(option.id);
                  if (!multi) setOpen(false);
                }}
                theme={theme}
                styles={styles}
              />
            ))}
            {options.length === 0 ? <Text style={styles.empty}>Nothing to choose from</Text> : null}
          </ScrollView>
          {multi ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={() => setOpen(false)}
              style={({ pressed }) => [styles.done, pressed ? styles.donePressed : null]}
            >
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          ) : null}
        </Modal.Content>
      </Modal>
    </>
  );
}

function Row({
  label,
  icon,
  iconColor,
  count,
  checked,
  role,
  onPress,
  theme,
  styles,
}: {
  label: string;
  icon?: string;
  iconColor?: string;
  count?: number;
  checked: boolean;
  role: "checkbox" | "radio";
  onPress(): void;
  theme: PluginTheme;
  styles: DropdownStyles;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        hovered ? styles.rowHovered : null,
        pressed ? styles.rowPressed : null,
      ]}
    >
      <View style={styles.check}>
        {checked ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
      </View>
      {icon ? <Icon name={icon} size={13} color={iconColor ?? theme.colors.foregroundMuted} /> : null}
      <Text style={styles.rowLabel} numberOfLines={2}>
        {label}
      </Text>
      {count !== undefined ? <Text style={styles.rowCount}>{count}</Text> : null}
    </Pressable>
  );
}

type DropdownStyles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 32,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      maxWidth: "100%",
    },
    triggerActive: { borderColor: theme.colors.accent },
    triggerHovered: { backgroundColor: theme.colors.surface2 },
    triggerPressed: { opacity: 0.8 },
    triggerLabel: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    triggerValue: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    triggerValueActive: { color: theme.colors.foreground, fontWeight: "600" },

    list: { maxHeight: 360 },
    listContent: { paddingVertical: 4 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 38,
      paddingVertical: 8,
      paddingHorizontal: 8,
      borderRadius: 8,
    },
    rowHovered: { backgroundColor: theme.colors.surface2 },
    rowPressed: { opacity: 0.8 },
    check: { width: 18, alignItems: "center" },
    rowLabel: { color: theme.colors.foreground, fontSize: 13, flex: 1 },
    rowCount: { color: theme.colors.foregroundMuted, fontSize: 12 },
    empty: { color: theme.colors.foregroundMuted, fontSize: 13, padding: 8 },
    done: {
      alignSelf: "flex-end",
      marginTop: 8,
      minHeight: 34,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 9,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    donePressed: { opacity: 0.85 },
    doneText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
  });
}
