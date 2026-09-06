import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "./open-external-url";

/**
 * A small Markdown renderer built on React Native text primitives, for the agent's final
 * message. The plugin SDK ships no Markdown component and plugin bundles cannot bring one, so
 * this covers what agents actually write: headings, paragraphs, bullet and numbered lists,
 * fenced and inline code, block quotes, rules, emphasis, and links. Tables and raw HTML are
 * shown as monospace text rather than dropped.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "list"; ordered: boolean; items: { text: string; depth: number }[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE = /^\s*\|/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let quote: string[] = [];
  let list: Extract<Block, { kind: "list" }> | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length > 0) blocks.push({ kind: "quote", text: quote.join(" ") });
    quote = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    if (code) {
      if (FENCE.test(line)) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (FENCE.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (line.trim().length === 0) {
      flushAll();
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1] ?? "");
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      flushQuote();
      const ordered = numbered !== null;
      const depth = Math.min(3, Math.floor((item[1]?.length ?? 0) / 2));
      if (!list || (list.ordered !== ordered && depth === 0)) {
        flushList();
        list = { kind: "list", ordered, items: [] };
      }
      list.items.push({ text: item[2] ?? "", depth });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A wrapped continuation of the previous list item.
      const last = list.items[list.items.length - 1];
      if (last) last.text = `${last.text} ${line.trim()}`;
      continue;
    }
    if (TABLE.test(line)) {
      flushAll();
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "code" && previous.text.startsWith("|")) {
        previous.text = `${previous.text}\n${line.trim()}`;
      } else {
        blocks.push({ kind: "code", text: line.trim() });
      }
      continue;
    }
    flushQuote();
    flushList();
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  flushAll();
  return blocks;
}

type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; text: string; url: string };

const LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y;
const AUTOLINK = /https?:\/\/[^\s<>()[\]"'`]+/y;
const CODE = /`+/y;

/** A hand-rolled scanner: nesting is limited to emphasis inside emphasis, which is plenty. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\" && index + 1 < text.length) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      CODE.lastIndex = index;
      const ticks = CODE.exec(text)?.[0] ?? "`";
      const close = text.indexOf(ticks, index + ticks.length);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", text: text.slice(index + ticks.length, close).trim() });
        index = close + ticks.length;
        continue;
      }
    }
    if (char === "[") {
      LINK.lastIndex = index;
      const link = LINK.exec(text);
      if (link) {
        flush();
        out.push({ kind: "link", text: link[1] ?? "", url: link[2] ?? "" });
        index += link[0].length;
        continue;
      }
    }
    if (char === "h" && text.startsWith("http", index)) {
      AUTOLINK.lastIndex = index;
      const url = AUTOLINK.exec(text)?.[0];
      if (url) {
        const trimmed = url.replace(/[.,;:!?]+$/, "");
        flush();
        out.push({ kind: "link", text: trimmed, url: trimmed });
        index += trimmed.length;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const double = text.startsWith(char + char, index);
      const marker = double ? char + char : char;
      const close = findClosing(text, index + marker.length, marker);
      if (close !== -1) {
        flush();
        const inner = parseInline(text.slice(index + marker.length, close));
        out.push(double ? { kind: "strong", children: inner } : { kind: "em", children: inner });
        index = close + marker.length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

function findClosing(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    const at = text.indexOf(marker, index);
    if (at === -1) return -1;
    const before = text[at - 1] ?? "";
    const after = text[at + marker.length] ?? "";
    // `a_b_c` is a word, not emphasis; `**` must close against non-space.
    if (before !== " " && !(marker.length === 1 && marker === "_" && /\w/.test(after))) {
      return at;
    }
    index = at + marker.length;
  }
  return -1;
}

export function Markdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} styles={styles} />
      ))}
    </View>
  );
}

function BlockView({ block, styles }: { block: Block; styles: MarkdownStyles }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text selectable style={[styles.heading, block.level <= 2 ? styles.headingLarge : null]}>
          <InlineView nodes={parseInline(block.text)} styles={styles} />
        </Text>
      );
    case "paragraph":
      return (
        <Text selectable style={styles.paragraph}>
          <InlineView nodes={parseInline(block.text)} styles={styles} />
        </Text>
      );
    case "code":
      return (
        <View style={styles.codeBlock}>
          <Text selectable style={styles.codeText}>
            {block.text}
          </Text>
        </View>
      );
    case "quote":
      return (
        <View style={styles.quote}>
          <Text selectable style={styles.quoteText}>
            <InlineView nodes={parseInline(block.text)} styles={styles} />
          </Text>
        </View>
      );
    case "rule":
      return <View style={styles.rule} />;
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={[styles.listItem, { paddingLeft: 4 + item.depth * 16 }]}>
              <Text style={styles.bullet}>{block.ordered ? `${index + 1}.` : "•"}</Text>
              <Text selectable style={styles.listText}>
                <InlineView nodes={parseInline(item.text)} styles={styles} />
              </Text>
            </View>
          ))}
        </View>
      );
  }
}

function InlineView({ nodes, styles }: { nodes: Inline[]; styles: MarkdownStyles }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return (
          <Text key={index} style={styles.inlineCode}>
            {node.text}
          </Text>
        );
      case "strong":
        return (
          <Text key={index} style={styles.strong}>
            <InlineView nodes={node.children} styles={styles} />
          </Text>
        );
      case "em":
        return (
          <Text key={index} style={styles.em}>
            <InlineView nodes={node.children} styles={styles} />
          </Text>
        );
      case "link":
        return (
          <Text
            key={index}
            accessibilityRole="link"
            style={styles.link}
            onPress={() => void openExternalUrl(node.url)}
          >
            {node.text}
          </Text>
        );
    }
  });
}

type MarkdownStyles = ReturnType<typeof createStyles>;

const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    root: { gap: 8 },
    heading: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700", lineHeight: 20 },
    headingLarge: { fontSize: 15 },
    paragraph: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19 },
    strong: { fontWeight: "700" },
    em: { fontStyle: "italic" },
    inlineCode: {
      fontFamily: MONOSPACE,
      fontSize: 12,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
    },
    link: { color: theme.colors.accent, textDecorationLine: "underline" },
    codeBlock: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    codeText: { fontFamily: MONOSPACE, fontSize: 12, lineHeight: 17, color: theme.colors.foreground },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      paddingLeft: 10,
    },
    quoteText: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginVertical: 2 },
    list: { gap: 3 },
    listItem: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
    bullet: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19, minWidth: 14 },
    listText: { color: theme.colors.foreground, fontSize: 13, lineHeight: 19, flex: 1 },
  });
}
