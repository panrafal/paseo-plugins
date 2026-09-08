import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

/**
 * A small toggle used for every filter: a checkbox when several can be on at once, a radio when
 * exactly one of a group is. The optional leading glyph carries the status color; the optional
 * trailing count sits in a muted badge.
 */
export function Chip({
  label,
  selected,
  role,
  onPress,
  theme,
  icon,
  iconColor,
  count,
  accessibilityHint,
  disabled = false,
}: {
  label: string;
  selected: boolean;
  role: "checkbox" | "radio";
  onPress(): void;
  theme: PluginTheme;
  icon?: string;
  iconColor?: string;
  count?: number;
  accessibilityHint?: string;
  /** Shown muted and inert: the toggle has no effect in the current mode. */
  disabled?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  const foreground = selected && !disabled ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        selected && !disabled ? styles.chipSelected : null,
        hovered && !selected && !disabled ? styles.chipHovered : null,
        pressed ? styles.chipPressed : null,
        disabled ? styles.chipDisabled : null,
      ]}
    >
      {icon ? <Icon name={icon} size={12} color={iconColor ?? foreground} /> : null}
      <Text style={[styles.label, { color: foreground }]} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined ? (
        <View style={styles.badge}>
          <Text style={styles.count}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 30,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      maxWidth: "100%",
    },
    chipSelected: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.accent },
    chipHovered: { backgroundColor: theme.colors.surface2 },
    chipPressed: { opacity: 0.8 },
    chipDisabled: { opacity: 0.45 },
    label: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
    badge: {
      minWidth: 18,
      height: 16,
      paddingHorizontal: 5,
      borderRadius: 8,
      backgroundColor: theme.colors.surface0,
      alignItems: "center",
      justifyContent: "center",
    },
    count: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
  });
}
