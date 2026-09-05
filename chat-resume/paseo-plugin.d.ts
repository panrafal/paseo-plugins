declare module "@getpaseo/plugin" {
  import type { ComponentType } from "react";
  import type { PaseoApi } from "@getpaseo/client";
  import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

  export interface PluginRpcContract<
    InputSchema extends ZodType = ZodType,
    OutputSchema extends ZodType = ZodType,
  > {
    name: string;
    input: InputSchema;
    output: OutputSchema;
  }

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

  interface PluginNavigableHostProps extends PluginHostProps {
    readonly navigation?: {
      readonly openAgent: (input: { readonly agentId: string }) => void;
      readonly openWorkspace: (input: { readonly workspaceId: string }) => void;
    };
  }

  export interface PluginAgentPanelProps extends PluginNavigableHostProps {
    context: "agent";
    workspaceId: string;
    agentId: string;
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

  export interface PluginClientContext {
    paseo: PaseoApi;
    rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>>;
    addWorkspacePanel(contribution: {
      id: string;
      title: string;
      icon: string;
      locations?: readonly ("workspace" | "explorer")[];
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    }): PluginCleanup;
    addComposerPill(contribution: PluginComposerPillContribution): PluginCleanup;
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

  export type PluginCleanup = () => void | Promise<void>;
  export const Icon: ComponentType<{ name: string; size?: number; color?: string }>;
  export function usePaseo(): PaseoApi;
  export function useAgent<Selection>(
    agentId: string,
    selector: (agent: {
      readonly provider: string;
      readonly labels: Readonly<Record<string, string>>;
    }) => Selection,
  ): Selection | null;
}
