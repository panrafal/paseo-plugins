import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Modal as NativeModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

/**
 * A filter selector: a trigger that reads like `Status: Succeeded` and opens a picker. On a
 * desktop-sized layout the picker is a popover anchored under the trigger, so a change is one
 * click away; on a phone it is the host's own sheet, where a floating menu would not fit.
 * Multi-select pickers offer an "All" row that clears the selection; single-select ones close
 * as soon as a row is chosen.
 */
const POPOVER_MIN_WIDTH = 220;
const POPOVER_MAX_WIDTH = 440;
const POPOVER_MAX_HEIGHT = 360;
const POPOVER_GAP = 4;
const WINDOW_MARGIN = 8;

interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}
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
  clearLabel?: string;
  theme: PluginTheme;
  icon?: string;
  /** Phones get the host sheet; everything else gets an anchored popover. */
  compact: boolean;
}

export function Dropdown({
  label,
  summary,
  options,
  selected,
  multi,
  onToggle,
  onClear,
  clearLabel = "All",
  theme,
  icon,
  compact,
}: DropdownProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // The popover sizes to its longest row; its own width is only known once laid out, so the
  // shift that keeps it inside the window is applied on layout.
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null);
  const triggerRef = useRef<View>(null);
  const window = useWindowDimensions();

  const openPicker = useCallback(() => {
    const trigger = triggerRef.current;
    if (compact || !trigger) {
      setOpen(true);
      return;
    }
    // Measured on each open: the trigger moves whenever the filter row wraps differently.
    trigger.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setPopoverWidth(null);
      setOpen(true);
    });
  }, [compact]);
  const close = useCallback(() => setOpen(false), []);
  // A single-select always has one row checked; only a narrowing choice counts as active.
  const active = summary !== null;
  const value = summary ?? "All";

  const rows = (
    <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
      {multi ? (
        <Row
          label={clearLabel}
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
            if (!multi) close();
          }}
          theme={theme}
          styles={styles}
        />
      ))}
      {options.length === 0 ? <Text style={styles.empty}>Nothing to choose from</Text> : null}
    </ScrollView>
  );

  return (
    <>
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityHint={`Choose ${label.toLowerCase()}`}
        accessibilityState={{ expanded: open }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={openPicker}
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

      {compact ? (
        <Modal title={label} open={open} onOpenChange={setOpen}>
          <Modal.Content>
            {rows}
            {multi ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Done"
                onPress={close}
                style={({ pressed }) => [styles.done, pressed ? styles.donePressed : null]}
              >
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            ) : null}
          </Modal.Content>
        </Modal>
      ) : (
        <NativeModal transparent visible={open} animationType="none" onRequestClose={close}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${label.toLowerCase()} picker`}
            onPress={close}
            style={styles.backdrop}
          />
          {anchor ? (
            <View
              accessibilityRole="menu"
              onLayout={(event) => setPopoverWidth(event.nativeEvent.layout.width)}
              style={[
                styles.popover,
                popoverPlacement(anchor, popoverWidth, window.width, window.height),
              ]}
            >
              {rows}
            </View>
          ) : null}
        </NativeModal>
      )}
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
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined ? <Text style={styles.rowCount}>{count}</Text> : null}
    </Pressable>
  );
}

/**
 * Under the trigger, left-aligned, as wide as its longest row between a floor (never narrower
 * than the trigger) and a ceiling. Once its width is known it is nudged back inside the window.
 */
function popoverPlacement(
  anchor: Anchor,
  measuredWidth: number | null,
  windowWidth: number,
  windowHeight: number,
) {
  const maxWidth = Math.min(POPOVER_MAX_WIDTH, windowWidth - WINDOW_MARGIN * 2);
  const minWidth = Math.min(maxWidth, Math.max(POPOVER_MIN_WIDTH, anchor.width));
  const width = measuredWidth ?? minWidth;
  const left = Math.max(WINDOW_MARGIN, Math.min(anchor.x, windowWidth - width - WINDOW_MARGIN));
  const below = anchor.y + anchor.height + POPOVER_GAP;
  const spaceBelow = windowHeight - below - WINDOW_MARGIN;
  const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.max(120, spaceBelow));
  return { left, top: below, minWidth, maxWidth, maxHeight };
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

    backdrop: { ...StyleSheet.absoluteFillObject },
    popover: {
      position: "absolute",
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      paddingHorizontal: 4,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    list: { maxHeight: POPOVER_MAX_HEIGHT },
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
    rowLabel: { color: theme.colors.foreground, fontSize: 13, flexGrow: 1, flexShrink: 1 },
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
