/**
 * Renders the BBCode of a GDScript docstring as Markdown for a hover.
 *
 * Godot documents its API in BBCode, and the `##` comments of a script use the
 * same tags. Markdown has no equivalent for most of them, so each tag is
 * translated into what a hover can display: runs of `[br]` become paragraph
 * breaks, code keeps its content literal, references become inline code, and
 * layout tags that only matter inside the editor are dropped.
 */

/** A code block or inline span, replaced by this marker while tags are applied. */
const PLACEHOLDER = "\u0000";

const placeholder = (index: number): string => `${PLACEHOLDER}${index}${PLACEHOLDER}`;

/** Fenced blocks: `[codeblock]`, `[codeblock lang=…]`, `[gdscript]`, `[csharp]`. */
const FENCED_BLOCK = /\[(codeblock|gdscript|csharp)(?:\s[^\]]*)?\]\n?([\s\S]*?)\[\/\1\]/g;

/** Inline `[code]` and `[code skip-lint]` spans. */
const INLINE_CODE = /\[code(?:\s[^\]]*)?\]([\s\S]*?)\[\/code\]/g;

/** Reference tags that name a symbol; `[param]` shares the shape. */
const REFERENCE =
	/\[(?:method|constructor|member|constant|enum|signal|theme_item|annotation|param)\s+(@?[A-Za-z_][\w.]*)\]/g;

/** A bare class reference. A preceding identifier keeps `Array[Node]` intact. */
const CLASS_REFERENCE = /(?<![\w])\[([A-Z][A-Za-z0-9_.]*)\]/g;

/**
 * Tags that only affect the Godot editor layout. Their content stays; the tag
 * itself carries nothing a hover can show.
 */
const LAYOUT_TAG =
	/\[\/?(?:center|color|bgcolor|fgcolor|font|font_size|outline_size|outline_color|table|cell|ul|ol|indent|img|u|codeblocks)(?:[=\s][^\]]*)?\]/g;

/** A run of `[br]` and the whitespace around it. */
const LINE_BREAK_RUN = /\s*(?:\[br\]\s*)+/g;

/**
 * Markdown for a run of breaks. A lone break stays inside its paragraph as a
 * hard line break (two trailing spaces), because a plain newline renders as a
 * space; any longer run starts a new paragraph, the closest a hover can get to
 * the blank line Godot draws.
 */
const line_break = (run: string): string => {
	const breaks = (run.match(/\[br\]|\n/g) ?? []).length;
	return breaks > 1 ? "\n\n" : "  \n";
};

/** A fenced block; the language is only known for the two language tags. */
const fenced = (tag: string, code: string): string =>
	`\`\`\`${tag === "gdscript" || tag === "csharp" ? tag : ""}\n${code.trim()}\n\`\`\``;

/**
 * Wraps `content` in a code span. Content that already holds a backtick needs a
 * longer fence, which Markdown expresses with repeated delimiters.
 */
const codeSpan = (content: string): string => {
	const fence = content.includes("`") ? "``" : "`";
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content.trim()}${padding}${fence}`;
};

/** Replaces a match with a placeholder and records its rendered form. */
const stash = (blocks: string[], rendered: string): string => {
	blocks.push(rendered);
	return placeholder(blocks.length - 1);
};

const restore = (text: string, blocks: readonly string[]): string =>
	blocks.reduce((result, block, index) => result.replace(placeholder(index), () => block), text);

/**
 * Markdown for one docstring. Code is stashed first so no later rule rewrites
 * its content, then the tags are translated and the stashed code is restored.
 */
export function bbcodeToMarkdown(bbcode: string): string {
	const blocks: string[] = [];
	const stashed = bbcode
		.replaceAll(FENCED_BLOCK, (_match, tag: string, code: string) => stash(blocks, fenced(tag, code)))
		.replaceAll(INLINE_CODE, (_match, content: string) => stash(blocks, codeSpan(content)));

	const converted = stashed
		.replace(LINE_BREAK_RUN, line_break)
		.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/g, "[$2]($1)")
		.replace(/\[url\]([\s\S]*?)\[\/url\]/g, "<$1>")
		.replace(/\[b\]([\s\S]*?)\[\/b\]/g, "**$1**")
		.replace(/\[i\]([\s\S]*?)\[\/i\]/g, "*$1*")
		.replace(/\[s\]([\s\S]*?)\[\/s\]/g, "~~$1~~")
		.replace(/\[kbd\]([\s\S]*?)\[\/kbd\]/g, (_match, content: string) => codeSpan(content))
		.replaceAll("[lb]", "\\[")
		.replaceAll("[rb]", "\\]")
		.replace(REFERENCE, (_match, name: string) => codeSpan(name))
		.replace(CLASS_REFERENCE, (_match, name: string) => codeSpan(name))
		.replace(LAYOUT_TAG, "");

	return restore(converted, blocks)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
