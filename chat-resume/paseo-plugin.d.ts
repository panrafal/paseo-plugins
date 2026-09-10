// Vendored type surface for the Paseo v0.8 plugin SDK.
// The daemon supplies these modules at build time; the split below mirrors the
// SDK's exports map: root (shared), /client, /client/react-native, /client/ui, /server.

declare module "@getpaseo/plugin" {
  import type { AgentTimelineItem, JsonValue } from "@getpaseo/protocol/agent-types";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  /** Handler parameter type: the contract input after Zod parsing. */
  export type RpcInput<Contract extends PluginRpcContract> = ZodOutput<Contract["input"]>;
  /** Handler return type: what the contract output schema accepts. */
  export type RpcOutput<Contract extends PluginRpcContract> = ZodInput<Contract["output"]>;

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

  export interface PluginAttachmentItem {
    id: string;
    identifier: string;
    title: string;
    subtitle?: string;
    url: string;
    text: string;
    resourceType: string;
  }

  export interface PluginAttachmentSearchPayload {
    items: PluginAttachmentItem[];
  }

  export interface PluginAttachmentSourceContribution {
    id: string;
    title: string;
    icon: string;
    pickerTitle: string;
    searchPlaceholder: string;
    search: PluginRpcContract;
  }

  export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
    definition: Definition,
  ): Definition;

  export const PluginAttachmentItemSchema: import("zod").ZodType<PluginAttachmentItem>;
  export const PluginAttachmentSearchPayloadSchema: import("zod").ZodType<PluginAttachmentSearchPayload>;

  export interface PluginTheme {
    readonly colors: {
      readonly surface0: string;
      readonly surface1: string;
      readonly surface2: string;
      readonly border: string;
      readonly foreground: string;
      readonly foregroundMuted: string;
      readonly accent: string;
      readonly accentForeground: string;
      readonly statusSuccess: string;
      readonly statusWarning: string;
      readonly statusDanger: string;
    };
  }

  export interface PluginWorkspaceSnapshot {
    readonly id: string;
    readonly projectId: string;
    readonly projectDisplayName: string;
    readonly projectRootPath: string;
    readonly directory: string;
    readonly projectKind: "git" | "non_git" | "directory";
    readonly kind: "directory" | "local_checkout" | "checkout" | "worktree";
    readonly name: string;
    readonly title: string | null;
    readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
    readonly statusEnteredAt: string | null;
    readonly archivingAt: string | null;
    readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  }

  export interface PluginAgentSnapshot {
    readonly id: string;
    readonly workspaceId: string;
    readonly provider: string;
    readonly status: "initializing" | "idle" | "running" | "error" | "closed";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly title: string | null;
    readonly cwd: string;
    readonly model: string | null;
    readonly currentModeId: string | null;
    readonly thinkingOptionId: string | null;
    readonly requiresAttention: boolean;
    readonly attentionReason: "finished" | "error" | "permission" | null;
    readonly parentAgentId: string | null;
    readonly labels: Readonly<Record<string, string>>;
  }

  export interface PluginThemeColors {
    background: string;
    foreground: string;
    raised: string;
    control: string;
    border: string;
    accent?: string;
    mutedForeground: string;
    ring: string;
  }

  export interface PluginThemeContribution {
    id: string;
    name: string;
    appearance: "light" | "dark";
    colors: PluginThemeColors;
  }

  export type PluginTimelineData = JsonValue;
  export interface PluginTimelineItem {
    type: "plugin";
    id?: string;
    kind: string;
    version: number;
    data: PluginTimelineData;
  }
  export interface PluginTimelineTransformResult {
    items: PluginTimelineItem[];
  }
  export type PluginTimelineTransformerContribution<
    ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
  > = ItemType extends AgentTimelineItem["type"]
    ? {
        id: string;
        query: { itemType: ItemType };
        transform(input: {
          item: Extract<AgentTimelineItem, { type: ItemType }>;
          phase: "streaming" | "complete";
        }): PluginTimelineTransformResult | undefined;
      }
    : never;

  export type PluginCleanup = () => void | Promise<void>;
}

declare module "@getpaseo/plugin/client" {
  import type { ComponentType } from "react";
  import type { PaseoApi } from "@getpaseo/client";
  import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
  import type {
    PluginAgentSnapshot,
    PluginAttachmentSourceContribution,
    PluginCleanup,
    PluginRpcContract,
    PluginTheme,
    PluginThemeContribution,
    PluginTimelineTransformerContribution,
    PluginWorkspaceSnapshot,
  } from "@getpaseo/plugin";

  export interface PluginHostProps {
    theme: PluginTheme;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  interface PluginNavigableHostProps extends PluginHostProps {
    /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
    readonly navigation?: {
      readonly openAgent: (input: { readonly agentId: string }) => void;
      readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
    };
  }

  export interface PluginSurfaceProps extends PluginNavigableHostProps {}

  export interface PluginIconProps {
    name: string;
    size?: number;
    color?: string;
  }

  export interface PluginWorkspacePanelProps extends PluginNavigableHostProps {
    context: "workspace";
    workspaceId: string;
  }

  export interface PluginAgentPanelProps extends PluginNavigableHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
  }

  export type PluginButtonContext =
    | { context: "workspace"; workspaceId: string }
    | { context: "agent"; workspaceId: string; agentId: string };

  export type PluginButtonIconProps = PluginHostProps &
    PluginButtonContext & { size: number; color: string };

  export type PluginButtonContentProps = PluginHostProps & PluginButtonContext & { close(): void };

  export type PluginButtonIcon = string | ComponentType<PluginButtonIconProps>;

  export type PluginButtonBehavior =
    | { kind: "action"; onPress(): void | Promise<void> }
    | { kind: "menu"; items: readonly PluginButtonMenuEntry[] }
    | { kind: "popover"; Content: ComponentType<PluginButtonContentProps> };

  export type PluginButtonMenuEntry =
    | { kind: "separator"; id: string }
    | {
        kind: "item";
        id: string;
        title: string;
        icon?: PluginButtonIcon;
        visible?: boolean;
        disabled?: boolean;
        behavior: PluginButtonBehavior;
      };

  export interface PluginButton {
    title: string;
    icon: PluginButtonIcon;
    /** Omit for an icon-only header button. Composer pills use title when omitted. */
    label?: string;
    visible?: boolean;
    disabled?: boolean;
    behavior: PluginButtonBehavior;
  }

  export interface PluginButtonRegistration {
    /** Updates presentation in place. Supply a complete behavior to replace it. */
    update(patch: Partial<PluginButton>): void;
    /** Idempotent. Updates after removal do nothing. */
    remove(): void;
  }

  export interface PluginHeaderButtonContribution {
    id: string;
    workspaceId: string;
    button: PluginButton;
  }

  export interface PluginComposerPillContribution extends PluginHeaderButtonContribution {
    agentId: string;
  }

  export type PluginPanelLocation = "workspace" | "explorer";
  export interface PluginOpenPanelOptions {
    location?: PluginPanelLocation;
  }
  export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
    workspaceId: string;
    agentId?: string;
  }

  interface PluginWorkspacePanelBase {
    id: string;
    title: string;
    icon: string;
    locations?: readonly PluginPanelLocation[];
  }

  export type PluginWorkspacePanelContribution =
    | (PluginWorkspacePanelBase & {
        context: "workspace";
        Component: ComponentType<PluginWorkspacePanelProps>;
      })
    | (PluginWorkspacePanelBase & {
        context: "agent";
        Component: ComponentType<PluginAgentPanelProps>;
      });

  export interface PluginSidebarContribution {
    id: string;
    title: string;
    icon: string;
    surface: string;
  }

  export interface PluginSurfaceContribution {
    id: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginSettingsScreenContribution {
    id: string;
    title: string;
    icon: string;
    Component: ComponentType<PluginSurfaceProps>;
  }

  export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
    agentId: string;
    item: { type: "plugin"; kind: string; version: number; data: Data };
    timestamp: Date;
  }
  export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
    kind: string;
    version: number;
    schema: Schema;
    Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
  }

  export interface PluginCommandCapabilities {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    openSettings(id: string): void;
    openSurface(id: string): void;
  }

  export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
    context: "global";
  }

  export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
    context: "workspace";
    workspace: PluginWorkspaceSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  export interface PluginAgentCommandContext extends PluginCommandCapabilities {
    context: "agent";
    workspace: PluginWorkspaceSnapshot;
    agent: PluginAgentSnapshot;
    openPanel(id: string, options?: PluginOpenPanelOptions): void;
  }

  interface PluginCommandCenterItemBase {
    id: string;
    title: string;
    icon: string;
    keywords?: readonly string[];
  }

  export type PluginCommandCenterItemContribution =
    | (PluginCommandCenterItemBase & {
        context: "global";
        onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
      })
    | (PluginCommandCenterItemBase & {
        context: "workspace";
        onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
      })
    | (PluginCommandCenterItemBase & {
        context: "agent";
        onSelect(context: PluginAgentCommandContext): void | Promise<void>;
      });

  interface PluginClientSlashCommandBase {
    name: string;
    description: string;
    argumentHint: string;
  }

  export type PluginClientSlashCommandContribution =
    | (PluginClientSlashCommandBase & {
        context: "workspace";
        onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
      })
    | (PluginClientSlashCommandBase & {
        context: "agent";
        onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
      });

  /** The app-side entry context. Every `add*` returns an idempotent remover. */
  export interface PluginClientContext extends PluginCommandCapabilities {
    addSettingsScreen(contribution: PluginSettingsScreenContribution): PluginCleanup;
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
    addSidebarItem(contribution: PluginSidebarContribution): PluginCleanup;
    addWorkspacePanel(contribution: PluginWorkspacePanelContribution): PluginCleanup;
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution): PluginCleanup;
    addSlashCommand(contribution: PluginClientSlashCommandContribution): PluginCleanup;
    addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration;
    addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
    addAttachmentSource(contribution: PluginAttachmentSourceContribution): PluginCleanup;
    addTheme(contribution: PluginThemeContribution): PluginCleanup;
    addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
      contribution: PluginTimelineTransformerContribution<ItemType>,
    ): PluginCleanup;
    addTimelineRenderer<Schema extends ZodType>(
      contribution: PluginTimelineRendererContribution<Schema>,
    ): PluginCleanup;
    openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  }

  export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;

  export function usePaseo(): PaseoApi;

  export function useWorkspace<Selection>(
    workspaceId: string,
    selector: (workspace: PluginWorkspaceSnapshot) => Selection,
  ): Selection | null;

  export function useAgent<Selection>(
    agentId: string,
    selector: (agent: PluginAgentSnapshot) => Selection,
  ): Selection | null;
}

declare module "@getpaseo/plugin/client/react-native" {
  import type { ComponentType, FunctionComponent, ReactNode } from "react";
  import type { PluginIconProps } from "@getpaseo/plugin/client";

  export interface ModalProps {
    title: string;
    icon?: ReactNode;
    open: boolean;
    onOpenChange(open: boolean): void;
    children: ReactNode;
  }

  export interface ModalContentProps {
    children: ReactNode;
  }

  export interface ModalComponent extends FunctionComponent<ModalProps> {
    Content: ComponentType<ModalContentProps>;
  }

  export type ToastVariant = "default" | "info" | "success" | "warning" | "error";
  export interface ToastOptions {
    variant?: ToastVariant;
    durationMs?: number;
  }
  export interface ToastApi {
    show(message: string, options?: ToastOptions): void;
    error(message: string): void;
  }

  export const Icon: ComponentType<PluginIconProps>;
  export const Modal: ModalComponent;
  export function useToast(): ToastApi;
  export function useRevealedText(text: string, phase: "streaming" | "complete"): string;

  export type { PluginIconProps };
}

// Settings UI contract from the Paseo v0.8 plugin SDK.
declare module "@getpaseo/plugin/client/ui" {
  import type { ComponentType, ReactNode, Ref } from "react";
  export interface SettingsSectionProps {
    title: string;
    info?: ReactNode;
    trailing?: ReactNode;
    children: ReactNode;
    testID?: string;
  }
  export interface SettingsRowProps {
    label: string;
    hint?: string;
    error?: string | null;
    children?: ReactNode;
    testID?: string;
  }
  export interface SettingsSwitchProps extends SettingsRowProps {
    value: boolean;
    onValueChange(value: boolean): void;
    disabled?: boolean;
  }
  export interface SettingsSelectProps<Value extends string = string> extends SettingsRowProps {
    value: Value;
    options: readonly {
      label: string;
      value: Value;
    }[];
    onValueChange(value: Value): void;
    disabled?: boolean;
  }
  export interface SettingsInputHandle {
    focus(): void;
    blur(): void;
    getText(): string;
    replaceText(text: string): void;
  }
  export interface SettingsInputProps extends SettingsRowProps {
    initialValue?: string;
    onChangeText(text: string): void;
    placeholder?: string;
    disabled?: boolean;
    secureTextEntry?: boolean;
    ref?: Ref<SettingsInputHandle>;
  }
  export interface SettingsActionProps extends SettingsRowProps {
    actionLabel: string;
    onPress(): void;
    disabled?: boolean;
  }
  export const SettingsGroup: ComponentType<SettingsSectionProps>;
  export const SettingsSection: ComponentType<SettingsSectionProps>;
  export const SettingsCard: ComponentType<{
    children: ReactNode;
    testID?: string;
  }>;
  export const SettingsRow: ComponentType<SettingsRowProps>;
  export const SettingsSwitch: ComponentType<SettingsSwitchProps>;
  export function SettingsSelect<Value extends string>(props: SettingsSelectProps<Value>): ReactNode;
  export const SettingsInput: ComponentType<SettingsInputProps>;
  export const SettingsAction: ComponentType<SettingsActionProps>;
}

declare module "@getpaseo/plugin/server" {
  import type { PaseoApi } from "@getpaseo/client";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
  import type { PluginCleanup, PluginRpcContract } from "@getpaseo/plugin";

  export interface PluginHandlerContext {
    paseo: PaseoApi;
  }

  export interface PluginHookAgent {
    id: string;
    workspaceId: string | null;
    parentAgentId: string | null;
    provider: string;
    cwd: string;
    title: string | null;
  }

  export type PluginTurnOutcome =
    | { kind: "completed" }
    | { kind: "failed"; error: { message: string; code?: string } }
    | { kind: "canceled"; reason: string };

  export interface PluginLifecycleEvents {
    "agent.created": { agent: PluginHookAgent };
    "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
    "agent.turn_ended": {
      agent: PluginHookAgent;
      turnId: string | null;
      outcome: PluginTurnOutcome;
      timeline: readonly import("@getpaseo/protocol/agent-types").AgentTimelineItem[];
    };
    "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  }

  export interface PluginHookContext {
    paseo: PaseoApi;
    signal: AbortSignal;
  }

  /** The daemon-side entry context. */
  export interface PluginServerContext {
    on<Name extends keyof PluginLifecycleEvents>(
      name: Name,
      handler: (
        event: PluginLifecycleEvents[Name],
        context: PluginHookContext,
      ) => void | Promise<void>,
    ): () => void;
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: PluginHandlerContext,
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
  }

  export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
}
