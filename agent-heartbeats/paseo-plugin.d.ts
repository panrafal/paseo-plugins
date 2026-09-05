declare module "@getpaseo/plugin/react-native" {
  import type { ComponentType, FunctionComponent, ReactNode } from "react";

  export interface PluginIconProps {
    name: string;
    size?: number;
    color?: string;
  }

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

  export interface ToastApi {
    show(
      message: string,
      options?: {
        variant?: "default" | "info" | "success" | "warning" | "error";
        durationMs?: number;
      },
    ): void;
    error(message: string): void;
  }

  export const Icon: ComponentType<PluginIconProps>;
  export const Modal: ModalComponent;
  export function useToast(): ToastApi;
}

declare module "@getpaseo/plugin" {
  import type { PaseoApi } from "@getpaseo/client";
  import type { ComponentType } from "react";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

  export type RpcInput<Contract extends PluginRpcContract> = ZodOutput<Contract["input"]>;
  export type RpcOutput<Contract extends PluginRpcContract> = ZodInput<Contract["output"]>;

  export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }): PluginRpcContract<InputSchema, OutputSchema>;

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

  export interface PluginHostProps {
    theme: PluginTheme;
    host: { id: string; label: string };
    layout: { compact: boolean; platform: "ios" | "android" | "web" };
  }

  export interface PluginAgentPanelProps extends PluginHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
    navigation?: {
      openAgent(input: { agentId: string }): void;
      openWorkspace(input: { workspaceId: string }): void;
    };
  }

  export interface PluginComposerPillProps extends PluginHostProps {
    workspaceId: string;
    agentId: string;
  }

  export interface PluginComposerPillContribution {
    id: string;
    title: string;
    workspaceId: string;
    agentId: string;
    Component: ComponentType<PluginComposerPillProps>;
    onPress(): void | Promise<void>;
  }

  export interface PluginAgentPanelContribution {
    id: string;
    title: string;
    icon: string;
    context: "agent";
    Component: ComponentType<PluginAgentPanelProps>;
    locations?: readonly ("workspace" | "explorer")[];
  }

  export interface PluginClientContext {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    addWorkspacePanel(contribution: PluginAgentPanelContribution): () => void | Promise<void>;
    addComposerPill(contribution: PluginComposerPillContribution): () => void | Promise<void>;
    openPanel(
      id: string,
      options: {
        workspaceId: string;
        agentId?: string;
        location?: "workspace" | "explorer";
      },
    ): void;
  }

  export interface PluginServerContext {
    handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      handler: (
        input: ZodOutput<InputSchema>,
        context: { paseo: PaseoApi },
      ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
    ): void;
  }

  export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
  ): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>;
}
