import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/react-native";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { DashWorkspace } from "../shared/model";

/**
 * Archiving a workspace with work that only exists in its worktree loses that work, so the row
 * asks first. The dialog is only rendered when `describeArchiveRisks` found something to warn
 * about; a clean workspace archives straight away.
 */

/** Reasons archiving would discard work, phrased for the dialog. Empty means "safe to archive". */
export function describeArchiveRisks(workspace: DashWorkspace): readonly string[] {
  const risks: string[] = [];
  if (workspace.hasUncommittedChanges === true) {
    const diff = workspace.diffStat;
    const detail = diff ? ` (+${diff.additions} −${diff.deletions})` : "";
    risks.push(`Uncommitted changes${detail}`);
  }
  const unpushed = workspace.unpushedCommitCount ?? 0;
  if (unpushed > 0) {
    risks.push(`${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`);
  }
  return risks;
}

export interface ArchiveConfirmProps {
  open: boolean;
  workspaceName: string;
  risks: readonly string[];
  busy: boolean;
  theme: PluginTheme;
  onCancel(): void;
  onConfirm(): void;
}

export function ArchiveConfirm({
  open,
  workspaceName,
  risks,
  busy,
  theme,
  onCancel,
  onConfirm,
}: ArchiveConfirmProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      title={`Archive ${workspaceName}?`}
      icon={<Icon name="Archive" size={16} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <Text style={styles.intro}>
            Archiving removes the workspace from Paseo. This work is not saved anywhere else:
          </Text>
          <View style={styles.risks}>
            {risks.map((risk) => (
              <View key={risk} style={styles.risk}>
                <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
                <Text style={styles.riskText}>{risk}</Text>
              </View>
            ))}
          </View>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel archiving"
              disabled={busy}
              onPress={onCancel}
              style={({ pressed }) => [
                styles.button,
                styles.cancel,
                pressed ? styles.pressed : null,
                busy ? styles.disabled : null,
              ]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archive ${workspaceName}`}
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.button,
                styles.confirm,
                pressed ? styles.pressed : null,
                busy ? styles.disabled : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={theme.colors.accentForeground} />
              ) : (
                <Text style={styles.confirmText}>Archive</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    body: { gap: 14, paddingTop: 4, minWidth: 260 },
    intro: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    risks: { gap: 6 },
    risk: { flexDirection: "row", alignItems: "center", gap: 6 },
    riskText: { color: theme.colors.foreground, fontSize: 13 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" },
    button: {
      minHeight: 34,
      minWidth: 92,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    cancel: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cancelText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    confirm: { backgroundColor: theme.colors.accent },
    confirmText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.6 },
  });
}
